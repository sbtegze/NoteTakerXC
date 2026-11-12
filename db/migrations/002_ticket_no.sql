-- A jegy node-ot a jegyszám azonosítja, így a node szövege szabadon átírható
-- (pl. "#1234" -> "#1234 Számlakép export"), a felismerés mégis megtalálja.
ALTER TABLE nodes ADD COLUMN ticket_no INTEGER;
CREATE UNIQUE INDEX nodes_ticket_no_idx ON nodes (ticket_no) WHERE ticket_no IS NOT NULL;
