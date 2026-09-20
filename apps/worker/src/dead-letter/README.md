# Failure handling

BullMQ retains exhausted jobs for inspection. A future dead-letter processor must record the terminal failure in PostgreSQL and must never treat Redis job state as proof of financial completion.
