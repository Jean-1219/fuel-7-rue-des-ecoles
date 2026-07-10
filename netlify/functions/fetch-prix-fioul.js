// Fonction Netlify : récupère les prix hebdomadaires du fioul
// Source principale : Commission Européenne (API publique, sans restriction)
// Source fallback : cache Supabase

const fetch = require('node-fetch');

const SUPABASE_URL = 'https://tqurezznmkhvzbktwnnz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRxdXJlenpubWtodnpia3R3bm56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2MTg5ODAsImV4cCI6MjA5NjE5NDk4MH0.uBhhMzibGzWmiXoSxfZwLSPiORCjrGmO1TFbtoCWzeU';

const HEADERS_SB = {
  'apikey': SUPABASE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_KEY,
  'Content-Type': 'application/json',
  'Prefer': 'resolution=merge-duplicates'
};

// API Commission Européenne — Weekly Oil Bulletin
// Prix du fioul domestique (heating oil) pour la France, en €/L
const EU_API = 'https://ec.europa.eu/energy/observatory/api/public/products/weekly_oil_bulletin?productIds=4534&countryIds=FR&format=json';

exports.handler = async (event, context) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  try {
    console.log('Interrogation de l\'API Commission Européenne...');

    const response = await fetch(EU_API, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; FuelTracker/1.0)' },
      timeout: 15000
    });

    if (!response.ok) {
      throw new Error(`API EU : HTTP ${response.status}`);
    }

    const json = await response.json();
    console.log('Réponse EU reçue, nb enregistrements :', json.length || 0);

    if (!json || !Array.isArray(json) || json.length === 0) {
      throw new Error('Réponse EU vide ou invalide');
    }

    // Filtrer sur les 6 derniers mois
    const sixMoisAgo = new Date();
    sixMoisAgo.setMonth(sixMoisAgo.getMonth() - 6);

    const prixFioul = [];
    for (const item of json) {
      // Format attendu : { date: "2026-07-07", value: 0.xxxx, ... }
      const dateStr = item.date || item.Date || item.week_of || item.weekOf;
      const val = item.value || item.Value || item.price || item.Price;

      if (!dateStr || val === undefined || val === null) continue;

      const date = new Date(dateStr);
      if (isNaN(date) || date < sixMoisAgo) continue;

      let prix = parseFloat(val);
      if (isNaN(prix) || prix <= 0) continue;

      // L'API EU renvoie en €/1000L ou c€/L selon les cas → normaliser en €/L
      if (prix > 10) prix = prix / 1000;

      prixFioul.push({
        date: date.toISOString().slice(0, 10),
        prix_litre: Math.round(prix * 10000) / 10000
      });
    }

    // Dédoublonner et trier
    const byDate = {};
    prixFioul.forEach(p => { byDate[p.date] = p; });
    const sorted = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));

    console.log(`${sorted.length} entrées après filtrage`);

    if (sorted.length === 0) {
      throw new Error('Aucune donnée exploitable dans la réponse EU');
    }

    // Upsert dans Supabase
    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/prix_fioul_dgec`, {
      method: 'POST',
      headers: HEADERS_SB,
      body: JSON.stringify(sorted)
    });

    if (!upsertRes.ok) {
      console.error('Erreur Supabase upsert:', await upsertRes.text());
    } else {
      console.log(`${sorted.length} entrées sauvegardées dans Supabase`);
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ source: 'eu_fresh', data: sorted, count: sorted.length })
    };

  } catch (error) {
    console.error('Erreur API EU:', error.message, '— tentative DGEC directe...');

    // Fallback : tentative DGEC avec en-têtes simulant un navigateur
    try {
      const dgecRes = await fetch(
        'https://www.ecologie.gouv.fr/sites/default/files/documents/Prix%20HTT%20et%20TTC%20depuis%20janvier%202020_0.xlsx',
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://www.ecologie.gouv.fr/politiques-publiques/prix-produits-petroliers',
            'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*'
          },
          timeout: 20000
        }
      );
      if (dgecRes.ok) {
        console.log('DGEC accessible en fallback !');
        // Si DGEC répond, on retourne le cache Supabase à jour
      }
    } catch (e2) {
      console.warn('DGEC aussi inaccessible:', e2.message);
    }

    // Retourner le cache Supabase dans tous les cas d'échec
    try {
      const existing = await getExistingPrices();
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ source: 'supabase_cache', data: existing, error: error.message })
      };
    } catch (e3) {
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: error.message }) };
    }
  }
};

async function getExistingPrices() {
  const sixMoisAgo = new Date();
  sixMoisAgo.setMonth(sixMoisAgo.getMonth() - 6);
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/prix_fioul_dgec?date=gte.${sixMoisAgo.toISOString().slice(0,10)}&order=date.asc`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
  );
  if (!r.ok) return [];
  return r.json();
}
