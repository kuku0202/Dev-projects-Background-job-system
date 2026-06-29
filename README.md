Introduction
The background job system is a common component in the modern workflow. It can run jobs in an async fashion, which reduces the latency for clients. Some common examples include sending an email, scraping webpage, and producing a worksheet. In this project, you'll build a dummy background system.

Requirements
Client:

Push job to the queue.
Server:

Pull jobs from the queue and execute them.
Allow the background system to run more than one job at the same time. You'll also need a concurrency limit to avoiding too many jobs at the same time.
Retry the job when the job fails. Each job should have a retry limit.
For an extra challenge: Support scheduled jobs (e.g. run this job 2 days later)

Suggested Implementation
There are at least two components to implement: a client library and a background job server. You can use your preferred storage system to store the job (e.g. PostgreSQL, MySQL, Redis).

Since you need to run a job in a concurrent style, using programming languages like Node.js or Golang makes it easier to deal with the complexity. Alternatively, you can also use a language or framework you're more familiar with.