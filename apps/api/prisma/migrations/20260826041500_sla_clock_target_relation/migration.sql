-- Make the clock -> target link a real foreign key so escalation settings can be
-- read with the clock instead of a second lookup per breach during the sweep.
DELETE FROM sla_clocks WHERE target_id NOT IN (SELECT id FROM sla_targets);

ALTER TABLE sla_clocks
  ADD CONSTRAINT sla_clocks_target_id_fkey
  FOREIGN KEY (target_id) REFERENCES sla_targets(id) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS sla_clocks_target_id_idx ON sla_clocks (target_id);
