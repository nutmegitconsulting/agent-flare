# **Hermes Agent: Multi-Tenant Architecture & Data Flow**

This diagram illustrates how a single Cloudflare Worker acts as a gatekeeper, dynamically routing multiple authenticated users to their own isolated Cloudflare Sandbox instances, while ensuring their state (memory, files) is persisted into strictly partitioned prefixes within a shared Cloudflare R2 bucket.

## **Visual Architecture Map**

This flowchart maps the physical separation of users and their data. Notice how the Cloudflare Worker acts as the single entry point, safely splitting the traffic into isolated sandboxes and storage lanes.

flowchart TD  
    %% Define color styling for readability  
    classDef user fill:\#2563eb,stroke:\#1d4ed8,stroke-width:2px,color:\#fff,rx:5px,ry:5px  
    classDef auth fill:\#ea580c,stroke:\#c2410c,stroke-width:2px,color:\#fff,rx:5px,ry:5px  
    classDef compute fill:\#16a34a,stroke:\#15803d,stroke-width:2px,color:\#fff,rx:5px,ry:5px  
    classDef storage fill:\#9333ea,stroke:\#7e22ce,stroke-width:2px,color:\#fff,rx:5px,ry:5px

    %% 1\. The Users  
    subgraph External \["1. Web Browser (The Users)"\]  
        direction LR  
        UserA("User A (Tina)"):::user  
        UserB("User B (Gene)"):::user  
    end

    %% 2\. The Cloudflare Edge  
    subgraph Gatekeeper \["2. Security & Routing (Cloudflare Edge)"\]  
        direction TB  
        Access{"Cloudflare Access\\n(Verifies SSO Identity)"}:::auth  
        Worker\["Cloudflare Worker\\n(The API Router)"\]:::auth  
    end

    %% 3\. The Sandboxes  
    subgraph Sandboxes \["3. Isolated Agents (Cloudflare Sandboxes)"\]  
        direction LR  
        SBoxA("Sandbox A\\n(Tina's Agent Container)"):::compute  
        SBoxB("Sandbox B\\n(Gene's Agent Container)"):::compute  
    end

    %% 4\. The Storage  
    subgraph Storage \["4. Persistent Memory (Cloudflare R2)"\]  
        direction LR  
        R2A\[("Prefix: /users/Tina/\\n(Tina's Files & Memory)")\]:::storage  
        R2B\[("Prefix: /users/Gene/\\n(Gene's Files & Memory)")\]:::storage  
    end

    %% Map the connections  
    UserA \--\>|Logs In| Access  
    UserB \--\>|Logs In| Access

    Access \--\>|Passes Tina's ID| Worker  
    Access \--\>|Passes Gene's ID| Worker

    Worker \--\>|Routes HTTP/WebSockets| SBoxA  
    Worker \--\>|Routes HTTP/WebSockets| SBoxB

    SBoxA \<--\>|Saves/Loads Snapshot| R2A  
    SBoxB \<--\>|Saves/Loads Snapshot| R2B

## **Key Architectural Highlights**

1. **Zero-Trust Entry:** Every request must pass through Cloudflare Access. The Worker implicitly trusts the User ID provided by the Access JWT, ensuring users cannot spoof identities.  
2. **Dynamic Instantiation:** The Cloudflare Worker maps the authenticated User ID directly to a specific Durable Object ID. This guarantees that User A's requests will *always* route to Sandbox A, and User B's requests will *always* route to Sandbox B.  
3. **Strict Data Partitioning:** R2 storage is shared, but the Worker strictly enforces path prefixes based on the authenticated User ID (/users/\<UserID\>/). A user cannot request or manipulate data outside their assigned prefix.  
4. **State Hydration & Hibernation:** When a Sandbox spins up, the Worker pulls the user's specific snapshot from R2 and mounts it. When the Sandbox goes idle, the Worker ensures the current state is snapshotted back to the correct R2 prefix before allowing the Sandbox to hibernate, saving compute costs without losing context.