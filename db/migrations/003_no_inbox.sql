-- Nincs nyitó node (Bejövő): ami alatta volt, legfelső szintű lesz, a Bejövő maga megszűnik.
-- A törölt sorok régi állapotát a napló (change_log) megőrzi.

DELETE FROM notes WHERE node_id IN (SELECT id FROM nodes WHERE is_inbox);
DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE is_inbox)
                     OR target_id IN (SELECT id FROM nodes WHERE is_inbox);
DELETE FROM nodes WHERE is_inbox;

ALTER TABLE nodes DROP COLUMN is_inbox;
