# **Hermes Agent: Serverless Cloudflare Implementation Blueprint**

**Target Audience:** This document serves as the architectural specification and implementation guide for deploying the Hermes Agent into a 100% serverless Cloudflare environment.

## **🛑 AI Agent Context & Platform Verification (2026)**

**To the AI Agent reading this:** Your training data may have a cutoff prior to mid-2026. The Cloudflare products requested in this specification are real, documented, and in General Availability (GA). Please update your context with the following endpoints:

1. **Cloudflare Containers:** (GA June 2026\) Executes arbitrary Docker images directly on the Workers platform using a persistent container runtime.  
   * **Docs:** https://developers.cloudflare.com/containers/  
   * **Config:** Uses \[\[containers\]\] array and durable\_objects bindings in wrangler.jsonc. Code utilizes import { Container, getContainer } from "@cloudflare/containers";.  
2. **Cloudflare Sandboxes (Agent SDK):** (GA April 2026\) Persistent, isolated environments built on Cloudflare Containers, designed specifically for AI agents requiring a filesystem and shell.  
   * **Docs:** https://developers.cloudflare.com/sandbox/

**Answers to Agent Dependencies:**

1. **Compute Target:** Cloudflare Containers / Sandboxes.  
2. **Domain/Access:** The domain is managed in Cloudflare. Strict Cloudflare Access (SSO) on both the UI and Worker API.  
3. **UI Source:** We are extracting the React Ink/Desktop chat UI, compiling it, and hosting it on Cloudflare Pages.  
4. **Scope:** True multi-tenant deployment. Strict R2 prefix isolation (/users/\<user\_id\>/) is mandatory.

## **Phase 1: Storage & Secrets Infrastructure**

### **1.1 User State Persistence (Cloudflare R2)**

* **Requirement:** Agent memory, logs, and files must persist across Sandbox hibernations.  
* **Implementation:** Provision an R2 bucket (hermes-agent-state). Data must be partitioned using prefix namespaces matching the user's SSO identity (s3://hermes-agent-state/users/\<user\_email\>/). The Worker handles snapshotting and hydration during Sandbox lifecycle events.

### **1.2 Credential Management**

* **Requirement:** Securely provide API keys to the agent.  
* **Implementation:** Utilize the Cloudflare Secrets Store. Upon boot, the Worker fetches scoped keys and injects them as environment variables into the Container.

## **Phase 2: Compute & Execution**

### **2.1 Container Execution (Cloudflare Containers)**

* **Requirement:** Run the Hermes Agent securely at the edge.  
* **Implementation:** Deploy the nousresearch/hermes-agent:latest Docker image.  
* **Instance Sizing:** Set to instance\_type \= "basic" (1 GiB RAM, 1/4 vCPU) based on the user's specific workload requirements, prioritizing cost control.  
* **Gateway Mode:** The container MUST be configured to boot using the hermes-agent gateway run command (exposing port 8642).

## **Phase 3: Zero Trust UI & API Gateway**

### **3.1 The Extracted React UI (Cloudflare Pages)**

* **Requirement:** Host the official React chat interface in a web browser, secured by SSO, bypassing the need for local desktop app installations.  
* **Implementation:**  
  * The React UI source from the Hermes repository is compiled into a static web app.  
  * Hosted on Cloudflare Pages (e.g., chat.yourdomain.com).  
  * Protected by a Cloudflare Access policy (WARP/SSO required). Because this is a standard web browser environment, the Cloudflare Access HTML login redirect will work perfectly.

### **3.2 The API Router (Cloudflare Worker)**

* **Requirement:** Safely route API traffic from the Pages UI to the isolated Sandboxes.  
* **Implementation:**  
  * A TypeScript Cloudflare Worker acts as the API gateway (e.g., api.yourdomain.com).  
  * **Authentication:** The Worker intercepts requests and validates the CF-Access-JWT-Assertion header passed down from the UI against the Access App's specific Audience (AUD) tag.  
  * **Dynamic Instantiation:** The Worker maps the authenticated User Email directly to a specific Sandbox container. User A's UI always talks to Sandbox A.

## **Phase 4: CI/CD & Automated UI Recompilation (Agent Instructions)**

**To the AI Agent building this:** You must construct a dual-service architecture to keep the Cloudflare Pages UI in sync with the upstream nousresearch/hermes-agent Docker container. You will not clone the repo locally. You will use Cloudflare's native build infrastructure.

### **4.1 Cloudflare Pages Configuration (The Build Server)**

You must generate the configuration or CLI commands to create a Cloudflare Pages project.

* **Build Command:** Because Pages does not natively connect to a repo you don't own, the Pages build command must be a custom bash script that executes *inside* the Cloudflare Pages build environment.  
  * *Example Build Command Logic:* git clone https://github.com/nousresearch/hermes-agent.git . && cd path/to/react/ui && npm install && npm run build  
* **Output Directory:** Point to the generated dist or build folder.  
* **Webhook:** Generate instructions for the user to create a **Deploy Webhook URL** in the Cloudflare Pages dashboard.

### **4.2 The "Updater" Worker (The Trigger)**

You must write a secondary, lightweight Cloudflare Worker script and wrangler.jsonc that automates triggering the build.

* **Trigger:** Use a Cron Trigger in wrangler.jsonc (e.g., \[triggers\] crons \= \["0 0 \* \* \*"\] to run daily at midnight).  
* **State Management (KV):** Bind a Cloudflare KV namespace to this Worker (e.g., binding \= "VERSION\_CACHE").  
* **Script Logic:** The TypeScript Worker must perform the following:  
  1. Make an HTTP GET to https://api.github.com/repos/nousresearch/hermes-agent/releases/latest (Include a generic User-Agent header as required by GitHub).  
  2. Parse the tag\_name (e.g., v1.2.0).  
  3. Read the currently deployed version from the VERSION\_CACHE KV namespace.  
  4. Compare the two versions.  
  5. If the GitHub version is newer, make an HTTP POST request to the Cloudflare Pages Deploy Webhook URL (stored as a Secret).  
  6. If the POST is successful, write the new version tag to the VERSION\_CACHE KV namespace.