-- Runs once, the first time the Postgres volume is created.
-- Integration tests use their own database so they can wipe tables freely.
CREATE DATABASE pte_test OWNER pte;
