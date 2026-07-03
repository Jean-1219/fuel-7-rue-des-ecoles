-- ============================================================
-- Script SQL pour le suivi de fuel — 7 rue des Écoles
-- À coller dans Supabase > SQL Editor > New query
-- ============================================================

-- Table des relevés de niveau
CREATE TABLE IF NOT EXISTS releves (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  cm NUMERIC(5,1) NOT NULL,
  note TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table des livraisons
CREATE TABLE IF NOT EXISTS livraisons (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  qty INTEGER NOT NULL,
  prix NUMERIC(5,3),
  note TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index pour trier par date rapidement
CREATE INDEX IF NOT EXISTS releves_date_idx ON releves (date);
CREATE INDEX IF NOT EXISTS livraisons_date_idx ON livraisons (date);

-- Activer Row Level Security
ALTER TABLE releves ENABLE ROW LEVEL SECURITY;
ALTER TABLE livraisons ENABLE ROW LEVEL SECURITY;

-- Politique : accès public en lecture et écriture (clé anon)
CREATE POLICY "Accès public releves" ON releves
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Accès public livraisons" ON livraisons
  FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- Données historiques — relevés
-- ============================================================
INSERT INTO releves (date, cm, note) VALUES
  ('2020-09-25', 40, ''),
  ('2020-10-18', 34, ''),
  ('2020-11-22', 25, ''),
  ('2020-11-27', 24, ''),
  ('2021-01-17', 25, ''),
  ('2021-04-16', 41, ''),
  ('2021-09-28', 35, ''),
  ('2021-12-12', 49, ''),
  ('2022-01-30', 31, ''),
  ('2022-02-28', 21, ''),
  ('2022-11-07', 27, ''),
  ('2022-12-22', 14, ''),
  ('2023-02-14', 21, ''),
  ('2023-02-20', 43, ''),
  ('2023-07-31', 26, 'avant livraison'),
  ('2023-07-31', 53, 'après livraison'),
  ('2023-10-16', 53, ''),
  ('2023-12-20', 40, ''),
  ('2024-01-14', 24, ''),
  ('2025-09-01', 14, ''),
  ('2026-03-20', 11, 'avant livraison'),
  ('2026-03-20', 24, 'après livraison');

-- ============================================================
-- Données historiques — livraisons
-- ============================================================
INSERT INTO livraisons (date, qty, prix, note) VALUES
  ('2020-09-25', 400,  NULL, ''),
  ('2020-11-27', 500,  NULL, ''),
  ('2021-01-20', 1000, NULL, ''),
  ('2021-09-29', 800,  NULL, ''),
  ('2022-12-22', 500,  NULL, ''),
  ('2023-02-20', 500,  NULL, ''),
  ('2023-07-31', 650,  NULL, '27 cm après livraison'),
  ('2023-12-21', 500,  1.23, ''),
  ('2024-09-14', 1000, 1.08, ''),
  ('2025-09-02', 1000, 1.08, ''),
  ('2026-03-20', 200,  1.62, '');
