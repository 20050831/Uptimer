-- 0015: retention index for check_results.
--
-- The retention DELETE previously relied on idx_check_results_monitor_time
-- (monitor_id, checked_at), which does not serve the global
--   WHERE checked_at < cutoff ORDER BY checked_at LIMIT N
-- shape: every execution scanned the whole (monitor_id, checked_at) index,
-- costing ~374K rows read per statement and ~5.24M rows read per day at
-- production volume.
--
-- idx_check_results_checked_at_id (checked_at, id) is a covering index for
-- the retention SELECT (checked_at filter + id output, ORDER BY checked_at
-- satisfied by index order), so the id-harvest query reads only the rows it
-- returns.
--
-- Write-amplification note: each check_results INSERT now maintains one extra
-- index entry. Index maintenance on DELETE is charged as rows written either
-- way (D1 charges the index cleanup of both indexes on every deleted row), so
-- this index adds no incremental rows-written cost to the deletes themselves.
CREATE INDEX IF NOT EXISTS idx_check_results_checked_at_id
  ON check_results(checked_at, id);
