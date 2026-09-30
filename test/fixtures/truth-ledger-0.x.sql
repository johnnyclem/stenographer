-- A truth ledger written by stenographer 0.1.0-alpha.2 (mutable status column,
-- in-place dismissal), including the STENO-T-06 resurrection: the TB contested
-- twice was overridden, then set back to active when the other contest was refuted.
-- Generated with the pre-1.0 TruthLedger; do not edit by hand.
CREATE TABLE truth_entries (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        author TEXT NOT NULL,
        provenance TEXT NOT NULL,
        agent_session_id TEXT,
        origin TEXT NOT NULL DEFAULT 'local',
        body TEXT NOT NULL,
        status TEXT,
        target_ref TEXT,
        struck INTEGER NOT NULL DEFAULT 0,
        embedding BLOB
      );
CREATE TABLE truth_links (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        link_type TEXT NOT NULL,
        UNIQUE(from_id, to_id, link_type)
      );
INSERT INTO truth_entries (id, type, created_at, author, provenance, agent_session_id, origin, body, status, target_ref, struck, embedding) VALUES ('01M3TB7QCFHZXMB9K5Y9GSKHRG', 'TB', '2026-03-01T09:01:00.000Z', 'johnny', '{"kind":"manual"}', NULL, 'local', '{"claim":"LOG_BUDGET 30 is dead; it is 100","evidence":[{"kind":"commit","ref":"9f2c1ab"}],"signedBy":"johnny","status":"active","literals":[{"dead":"30","subject":"LOG_BUDGET","current":"100"}]}', 'active', NULL, 0, NULL);
INSERT INTO truth_entries (id, type, created_at, author, provenance, agent_session_id, origin, body, status, target_ref, struck, embedding) VALUES ('01M3TB7QCHXRSGG4M12NHAW66Q', 'UV', '2026-03-01T09:02:00.000Z', 'sam', '{"kind":"manual"}', NULL, 'local', '{"assertion":"LOG_BUDGET went back to 30 in the hotfix.","basis":"hotfix notes","verifyBy":{"kind":"inspect","value":"config.ts"},"contests":"01M3TB7QCFHZXMB9K5Y9GSKHRG","status":"verified"}', 'verified', NULL, 0, NULL);
INSERT INTO truth_entries (id, type, created_at, author, provenance, agent_session_id, origin, body, status, target_ref, struck, embedding) VALUES ('01M3TB7QCJ4B0W1C10MD6E3Z5W', 'UV', '2026-03-01T09:03:00.000Z', 'alex', '{"kind":"manual"}', NULL, 'local', '{"assertion":"LOG_BUDGET is 30 in staging.","basis":"a dashboard","verifyBy":{"kind":"command","value":"grep LOG_BUDGET config.ts"},"contests":"01M3TB7QCFHZXMB9K5Y9GSKHRG","status":"refuted"}', 'refuted', NULL, 0, NULL);
INSERT INTO truth_entries (id, type, created_at, author, provenance, agent_session_id, origin, body, status, target_ref, struck, embedding) VALUES ('01M3TB7QCMKBDNXR0VKSDQZV1E', 'ADDENDUM', '2026-03-01T09:04:00.000Z', 'kim', '{"kind":"manual"}', NULL, 'local', '{"evidence":[{"kind":"file","ref":"config.ts:3","detail":"LOG_BUDGET = 100"}],"note":"config.ts says 30 again"}', NULL, NULL, 0, NULL);
INSERT INTO truth_entries (id, type, created_at, author, provenance, agent_session_id, origin, body, status, target_ref, struck, embedding) VALUES ('01M3TB7QCMKBDNXR0VKSDQZV1F', 'TB', '2026-03-01T09:04:00.000Z', 'kim', '{"kind":"manual"}', NULL, 'local', '{"claim":"Overridden: \"LOG_BUDGET 30 is dead; it is 100\" — contradicted by verified assertion: LOG_BUDGET went back to 30 in the hotfix.","evidence":[{"kind":"file","ref":"config.ts:3","detail":"LOG_BUDGET = 100"}],"signedBy":"lee","status":"active"}', 'active', NULL, 0, NULL);
INSERT INTO truth_entries (id, type, created_at, author, provenance, agent_session_id, origin, body, status, target_ref, struck, embedding) VALUES ('01M3TB7QCNTR42MJW4DV4ET5R0', 'RULING', '2026-03-01T09:04:00.000Z', 'lee', '{"kind":"manual"}', NULL, 'local', '{"kind":"promotion","opinion":"config.ts says 30 again","target":"01M3TB7QCHXRSGG4M12NHAW66Q"}', NULL, NULL, 0, NULL);
INSERT INTO truth_entries (id, type, created_at, author, provenance, agent_session_id, origin, body, status, target_ref, struck, embedding) VALUES ('01M3TB7QCPN6AA95KHZAHY9KG0', 'ADDENDUM', '2026-03-01T09:05:00.000Z', 'kim', '{"kind":"manual"}', NULL, 'local', '{"evidence":[{"kind":"command","ref":"grep LOG_BUDGET staging.env","detail":"LOG_BUDGET=100"}],"note":null}', NULL, NULL, 0, NULL);
INSERT INTO truth_entries (id, type, created_at, author, provenance, agent_session_id, origin, body, status, target_ref, struck, embedding) VALUES ('01M3TB7QCQ8YGXH6MS0MN4YP5T', 'PROPOSAL', '2026-03-01T09:06:00.000Z', 'detector:supersession', '{"kind":"manual"}', NULL, 'local', '{"kind":"tombstone","draft":{"claim":"\"use postgres\" is superseded by \"use mysql\"","evidence":[{"kind":"message","ref":"m2"}]},"signal":{"source":"supersession-detector","score":0.71,"threshold":0.45},"targetRef":"decision_1","status":"dismissed","dismissedBy":"johnny","dismissReason":"false positive: unrelated decisions"}', 'dismissed', 'decision_1', 0, NULL);
INSERT INTO truth_entries (id, type, created_at, author, provenance, agent_session_id, origin, body, status, target_ref, struck, embedding) VALUES ('01M3TB7QCRZJYHVFPHJ856YRDE', 'PROPOSAL', '2026-03-01T09:07:00.000Z', 'agent:claude-code', '{"kind":"manual"}', 'sess_a', 'local', '{"kind":"tombstone","draft":{"claim":"fetchV1 is superseded by fetchV2","evidence":[{"kind":"commit","ref":"c0ffee1"}],"literals":[{"dead":"fetchV1","current":"fetchV2"}]},"signal":{"source":"agent-draft"},"targetRef":"decision_2","requiresNotary":true,"status":"signed"}', 'signed', 'decision_2', 0, NULL);
INSERT INTO truth_entries (id, type, created_at, author, provenance, agent_session_id, origin, body, status, target_ref, struck, embedding) VALUES ('01M3TB7QCT52HJ8AZ3TPAD8XG8', 'TB', '2026-03-01T09:08:00.000Z', 'johnny', '{"kind":"manual"}', NULL, 'local', '{"claim":"fetchV1 is superseded by fetchV2","evidence":[{"kind":"commit","ref":"c0ffee1"}],"signedBy":"johnny","status":"active","literals":[{"dead":"fetchV1","current":"fetchV2"}]}', 'active', NULL, 0, NULL);
INSERT INTO truth_entries (id, type, created_at, author, provenance, agent_session_id, origin, body, status, target_ref, struck, embedding) VALUES ('01M3TB7QCT52HJ8AZ3TPAD8XG9', 'TB', '2026-03-01T09:09:00.000Z', 'lee', '{"kind":"manual"}', NULL, 'local', '{"claim":"The cron box is decommissioned","evidence":[{"kind":"commit","ref":"9f2c1ab"}],"signedBy":"lee","status":"active"}', 'active', NULL, 1, NULL);
INSERT INTO truth_entries (id, type, created_at, author, provenance, agent_session_id, origin, body, status, target_ref, struck, embedding) VALUES ('01M3TB7QCV8CB5Z8K74395X37K', 'RULING', '2026-03-01T09:10:00.000Z', 'johnny', '{"kind":"manual"}', NULL, 'local', '{"kind":"strike","opinion":"the cited commit is on an abandoned branch","target":"01M3TB7QCT52HJ8AZ3TPAD8XG9"}', NULL, NULL, 0, NULL);
INSERT INTO truth_entries (id, type, created_at, author, provenance, agent_session_id, origin, body, status, target_ref, struck, embedding) VALUES ('01M3TB7QCWJFX4W3SQ3VSK1Y36', 'UV', '2026-03-01T09:11:00.000Z', 'alex', '{"kind":"manual"}', NULL, 'local', '{"assertion":"Retries are idempotent across regions.","basis":"design doc","verifyBy":{"kind":"ask","value":"sam"},"contests":null,"status":"open"}', 'open', NULL, 0, NULL);
INSERT INTO truth_entries (id, type, created_at, author, provenance, agent_session_id, origin, body, status, target_ref, struck, embedding) VALUES ('01M3TB7QCWJFX4W3SQ3VSK1Y37', 'TB', '2026-03-01T09:12:00.000Z', 'johnny', '{"kind":"manual"}', NULL, 'local', '{"claim":"The API is REST-only","evidence":[{"kind":"commit","ref":"9f2c1ab"}],"signedBy":"johnny","status":"overridden"}', 'overridden', NULL, 0, NULL);
INSERT INTO truth_entries (id, type, created_at, author, provenance, agent_session_id, origin, body, status, target_ref, struck, embedding) VALUES ('01M3TB7QCYGVREP90BPWVRWQY7', 'ADDENDUM', '2026-03-01T09:13:00.000Z', 'lee', '{"kind":"manual"}', NULL, 'local', '{"evidence":[{"kind":"commit","ref":"feed123"}],"note":"gRPC came back"}', NULL, NULL, 0, NULL);
INSERT INTO truth_entries (id, type, created_at, author, provenance, agent_session_id, origin, body, status, target_ref, struck, embedding) VALUES ('01M3TB7QCYGVREP90BPWVRWQY8', 'TB', '2026-03-01T09:14:00.000Z', 'migration', '{"kind":"migration","ref":"tombstone_17"}', NULL, 'local', '{"claim":"Superseded: \"use redis\" → \"use memcached\" (Superseded by newer decision)","evidence":[{"kind":"wiki","ref":"legacy:tombstone_17","detail":"pre-assertion auto-close"}],"signedBy":null,"status":"active"}', 'active', 'legacy:tombstone_17', 0, NULL);
INSERT INTO truth_entries (id, type, created_at, author, provenance, agent_session_id, origin, body, status, target_ref, struck, embedding) VALUES ('01JWIKI0000000000000000001', 'TB', '2026-03-01T09:15:00.000Z', 'teammate', '{"kind":"wiki","ref":"ops/regions"}', NULL, 'wiki', '{"claim":"The staging cluster is in us-east-1","evidence":[{"kind":"wiki","ref":"ops/regions"}],"signedBy":"teammate","status":"overridden"}', 'overridden', NULL, 0, NULL);
INSERT INTO truth_links (from_id, to_id, link_type) VALUES ('01M3TB7QCHXRSGG4M12NHAW66Q', '01M3TB7QCFHZXMB9K5Y9GSKHRG', 'contests');
INSERT INTO truth_links (from_id, to_id, link_type) VALUES ('01M3TB7QCJ4B0W1C10MD6E3Z5W', '01M3TB7QCFHZXMB9K5Y9GSKHRG', 'contests');
INSERT INTO truth_links (from_id, to_id, link_type) VALUES ('01M3TB7QCMKBDNXR0VKSDQZV1E', '01M3TB7QCHXRSGG4M12NHAW66Q', 'verifies');
INSERT INTO truth_links (from_id, to_id, link_type) VALUES ('01M3TB7QCMKBDNXR0VKSDQZV1F', '01M3TB7QCFHZXMB9K5Y9GSKHRG', 'supersedes');
INSERT INTO truth_links (from_id, to_id, link_type) VALUES ('01M3TB7QCMKBDNXR0VKSDQZV1E', '01M3TB7QCFHZXMB9K5Y9GSKHRG', 'overrides');
INSERT INTO truth_links (from_id, to_id, link_type) VALUES ('01M3TB7QCPN6AA95KHZAHY9KG0', '01M3TB7QCJ4B0W1C10MD6E3Z5W', 'refutes');
INSERT INTO truth_links (from_id, to_id, link_type) VALUES ('01M3TB7QCT52HJ8AZ3TPAD8XG8', '01M3TB7QCRZJYHVFPHJ856YRDE', 'signs');
INSERT INTO truth_links (from_id, to_id, link_type) VALUES ('01M3TB7QCV8CB5Z8K74395X37K', '01M3TB7QCT52HJ8AZ3TPAD8XG9', 'strikes');
INSERT INTO truth_links (from_id, to_id, link_type) VALUES ('01M3TB7QCYGVREP90BPWVRWQY7', '01M3TB7QCWJFX4W3SQ3VSK1Y37', 'overrides');
INSERT INTO truth_links (from_id, to_id, link_type) VALUES ('01JWIKIADDENDUM00000000001', '01JWIKI0000000000000000001', 'overrides');
