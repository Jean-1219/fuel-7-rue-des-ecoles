// Fonction Netlify : récupère les prix hebdomadaires du fioul DGEC
// et les stocke dans Supabase.
// Appelée via /.netlify/functions/fetch-prix-fioul (GET)
// ou automatiquement chaque lundi via un cron job.

const fetch = require('node-fetch');
const XLSX = require('xlsx');

const SUPABASE_URL = 'https://tqurezznmkhvzbktwnnz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRxdXJlenpubWtodnpia3R3bm56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2MTg5ODAsImV4cCI6MjA5NjE5NDk4MH0.uBhhMzibGzWmiXoSxfZwLSPiORCjrGmO1TFbtoCWzeU';

const HEADERS_SB = {
  'apikey': SUPABASE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_KEY,
  'Content-Type': 'application/json',
  'Prefer': 'resolution=merge-duplicates'
};

// URL du fichier Excel DGEC — prix hebdomadaires depuis 1985
const DGEC_URL = 'https://www.ecologie.gouv.fr/sites/default/files/2024_PrixProduitsPetroliers_Hebdomadaires.xlsx';

// Fallback : URL alternative
const DGEC_URL_ALT = 'https://www.statistiques.developpement-durable.gouv.fr/sites/default/files/2024_PrixProduitsPetroliers_Hebdomadaires.xlsx';

exports.handler = async (event, context) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  try {
    console.log('Récupération du fichier DGEC...');

    // Tentative de téléchargement du fichier Excel DGEC
    let buffer = null;
    let fetchError = null;

    for (const url of [DGEC_URL, DGEC_URL_ALT]) {
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FuelTracker/1.0)' },
          timeout: 15000
        });
        if (response.ok) {
          buffer = await response.buffer();
          console.log(`Fichier téléchargé depuis ${url}`);
          break;
        }
      } catch (e) {
        fetchError = e;
        console.warn(`Échec ${url}: ${e.message}`);
      }
    }

    if (!buffer) {
      // Si le fichier DGEC n'est pas accessible, on retourne les données Supabase existantes
      console.warn('Fichier DGEC inaccessible, retour des données Supabase');
      const existing = await getExistingPrices();
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ source: 'supabase_cache', data: existing })
      };
    }

    // Parsing du fichier Excel
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });

    // Chercher la feuille contenant le fioul domestique
    let prixFioul = [];

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

      // Chercher les colonnes date et fioul domestique
      let dateCol = -1, fioulCol = -1, headerRow = -1;

      for (let i = 0; i < Math.min(rows.length, 20); i++) {
        const row = rows[i];
        if (!row) continue;
        for (let j = 0; j < row.length; j++) {
          const cell = String(row[j] || '').toLowerCase();
          if (cell.includes('date') || cell.includes('semaine')) dateCol = j;
          if (cell.includes('fioul') || cell.includes('fuel') || cell.includes('fod')) fioulCol = j;
        }
        if (dateCol >= 0 && fioulCol >= 0) { headerRow = i; break; }
      }

      if (headerRow < 0) continue;

      // Extraire les données
      for (let i = headerRow + 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || !row[dateCol] || !row[fioulCol]) continue;

        let dateVal = row[dateCol];
        let prix = parseFloat(row[fioulCol]);
        if (isNaN(prix) || prix <= 0) continue;

        // Convertir la date
        let dateStr = null;
        if (dateVal instanceof Date) {
          dateStr = dateVal.toISOString().slice(0, 10);
        } else if (typeof dateVal === 'number') {
          // Date Excel sérialisée
          const d = XLSX.SSF.parse_date_code(dateVal);
          if (d) dateStr = `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
        } else if (typeof dateVal === 'string') {
          const match = dateVal.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
          if (match) {
            const y = match[3].length === 2 ? '20' + match[3] : match[3];
            dateStr = `${y}-${String(match[2]).padStart(2,'0')}-${String(match[1]).padStart(2,'0')}`;
          }
        }

        if (!dateStr) continue;

        // Le prix DGEC est en c€/L → convertir en €/L si > 10
        if (prix > 10) prix = prix / 100;

        // Garder uniquement les 6 derniers mois
        const sixMoisAgo = new Date();
        sixMoisAgo.setMonth(sixMoisAgo.getMonth() - 6);
        if (new Date(dateStr) < sixMoisAgo) continue;

        prixFioul.push({ date: dateStr, prix_litre: Math.round(prix * 1000) / 1000 });
      }

      if (prixFioul.length > 0) break;
    }

    // Si pas de données parsées depuis DGEC, retourner cache Supabase
    if (prixFioul.length === 0) {
      const existing = await getExistingPrices();
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ source: 'supabase_cache', data: existing })
      };
    }

    // Trier par date
    prixFioul.sort((a, b) => a.date.localeCompare(b.date));

    // Stocker dans Supabase (upsert)
    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/prix_fioul_dgec`, {
      method: 'POST',
      headers: HEADERS_SB,
      body: JSON.stringify(prixFioul)
    });

    if (!upsertRes.ok) {
      const err = await upsertRes.text();
      console.error('Erreur Supabase upsert:', err);
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ source: 'dgec_fresh', data: prixFioul, count: prixFioul.length })
    };

  } catch (error) {
    console.error('Erreur générale:', error);

    // En cas d'erreur, retourner les données existantes en Supabase
    try {
      const existing = await getExistingPrices();
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ source: 'supabase_cache', data: existing })
      };
    } catch (e2) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: error.message })
      };
    }
  }
};

async function getExistingPrices() {
  const sixMoisAgo = new Date();
  sixMoisAgo.setMonth(sixMoisAgo.getMonth() - 6);
  const dateStr = sixMoisAgo.toISOString().slice(0, 10);

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/prix_fioul_dgec?date=gte.${dateStr}&order=date.asc`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
  );
  if (!res.ok) return [];
  return res.json();
}
