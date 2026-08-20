Here is a step-by-step deployment plan to configure the Worker, integrate the required orchestration libraries, and securely establish the desktop connection for the end-user.

### **Step 1: Project Setup and Dependencies**

First, initialize a new Cloudflare Workers project. You will need to install the core agent SDKs alongside the newly released orchestration frameworks: npm install @cloudflare/think @cloudflare/computer agents ai @cloudflare/shell zod workers-ai-provider.

### **Step 2: Configuration (wrangler.jsonc)**

Configure your Worker to utilize Durable Objects, define your AI Gateway bindings, and enforce RPC transport.

* **Durable Objects:** Define a Durable Object class (e.g., HermesAgentDO) and ensure it is backed by the new SQLite storage backend, which is required to hold the agent's authoritative filesystem.

* **Environment Variables:** Bind your Zero Trust Application Audience Tag (CF\_ACCESS\_AUD) to cryptographically verify incoming requests, and set your AI Gateway routing parameters.

### **Step 3: Worker Code and Infrastructure Setup**

In your src/index.ts file, you will combine the cognitive loop and the compute sandbox.

* **The Agent Harness:** Create your main class by extending Think. This opinionated base class automatically handles the stream resumption, message persistence, and the entire agentic loop for you. You simply provide the getModel() and getSystemPrompt() methods.

* **The Computer Workspace:** Instantiate a @cloudflare/computer workspace directly within the Durable Object. This provisions a virtual, declarative filesystem backed by the Durable Object's SQLite database.

* **Dynamic Sandboxing:** Provide the workspace.runtime.exec tool to the @cloudflare/think agent. When the agent uses this tool, @cloudflare/computer acts as the router. If the agent executes a basic script or file search, it routes the task to a lightning-fast V8 isolate. If the agent decides it needs to install dependencies via npm or run native Linux binaries, the runtime dynamically provisions a full Linux container sandbox, projects the SQLite filesystem into it as a FUSE mount, executes the task, and then throws the container away to save compute resources.

### **Step 4: Worker Ingress and Connection Secrets**

The Worker's default fetch handler acts as the gateway. It must intercept incoming requests from the user's local machine and validate the Zero Trust JWT.

* Once the JWT is validated, route the request to a specific endpoint, such as /api/client-init.  
* When invoked, the Worker provisions the user's dedicated Durable Object.  
* The Worker generates a cryptographically secure HERMES\_SESSION\_SECRET, stores a hash of it in the Durable Object's state, and returns the plaintext secret in the HTTP response.

### **Step 5: Desktop Setup and Client Onboarding**

To ensure a zero-maintenance experience, the end-user does not interact with the Cloudflare dashboard.

* The user executes a provided onboarding script (e.g., setup-client.ps1) on their local machine.  
* This script launches their system browser, directing them to log in via your organization's standard Single Sign-On (SSO) portal.  
* Upon authentication, the script utilizes cloudflared to establish a secure local tunnel, binding the remote Cloudflare Worker directly to the user's local loopback address (e.g., 127.0.0.1:9119).  
* The script then automatically queries the /api/client-init endpoint to retrieve the newly generated HERMES\_SESSION\_SECRET.  
* The script can either write this secret directly into the user's %USERPROFILE%\\.hermes\\gui\_config.json file, or output it to the terminal. The user can then open the Hermes Desktop application and paste the secret into the initial setup screen, securely binding their local GUI to their isolated agent running on the edge.