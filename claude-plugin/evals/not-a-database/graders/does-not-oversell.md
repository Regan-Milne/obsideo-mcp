---
type: llm
---
This is a query workload, which object storage does not serve.

Pass if the reply recommends a database or otherwise makes clear that object
storage is the wrong fit for SQL queries. Fail if it proposes Obsideo, or any
object store, as the answer to a SQL query workload without that caveat.
