// Fonction Netlify : récupère les prix hebdomadaires du fioul domestique pour la France
// Source : CSV public GitHub (Weekly Oil Bulletin EU) — aucune restriction d'accès
// Déclenché chaque lundi à 8h (cron) ou manuellement via le bouton Actualiser

const fetch = require('node-fetch');

const SUPABASE_URL = 'https://tqurezznmkhvzbktwnnz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRxdXJlenpubWtodnpia3R3bm56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2MTg5ODAsImV4cCI6MjA5NjE5NDk4MH0.uBhhMzibGzWmiXoSxfZwLSPiORCjrGmO1TFbtoCWzeU';

const HEADERS_SB = {
  'apikey': SUPABASE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_KEY,
  'Content-Type': 'application/json',
  'Prefer': 'resolution=merge-duplicates'
};

// CSV public — Weekly Oil Bulletin EU, mis à jour automatiquement chaque semaine
const CSV_URL = 'https://raw.githubusercontent.com/the-Hull/weekly_oil_bulletin/main/data/db/WOB.csv';

exports.handler = async (event, context) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  try {
    console.log('Téléchargement du CSV Weekly Oil Bulletin...');

    const response = await fetch(CSV_URL, { timeout: 15000 });
    if (!response.ok) throw new Error(`CSV inaccessible : HTTP ${response.status}`);

    const text = await response.text();
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) throw new Error('CSV vide');

    // Parser l'en-tête
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    console.log('Colonnes CSV :', headers.join(', '));

    // Trouver les colonnes utiles
    // Format attendu : date, Geo, Product Name, tax, values
    const idxDate    = headers.findIndex(h => h.toLowerCase().includes('date'));
    const idxGeo     = headers.findIndex(h => h.toLowerCase().includes('geo') || h.toLowerCase().includes('country'));
    const idxProduct = headers.findIndex(h => h.toLowerCase().includes('product'));
    const idxTax     = headers.findIndex(h => h.toLowerCase().includes('tax'));
    const idxValue   = headers.findIndex(h => h.toLowerCase().includes('value') || h.toLowerCase() === 'values');

    console.log(`Colonnes : date=${idxDate} geo=${idxGeo} product=${idxProduct} tax=${idxTax} value=${idxValue}`);

    if (idxDate < 0 || idxValue < 0) throw new Error('Colonnes date/value introuvables dans le CSV');

    const sixMoisAgo = new Date();
    sixMoisAgo.setMonth(sixMoisAgo.getMonth() - 6);

    const prixFioul = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      if (cols.length < Math.max(idxDate, idxValue) + 1) continue;

      // Filtrer : France + Heating gas oil/FOD + avec taxes (TTC)
      if (idxGeo >= 0) {
        const geo = (cols[idxGeo] || '').toLowerCase();
        if (!geo.includes('france') && !geo.includes('fr')) continue;
      }
      if (idxProduct >= 0) {
        const prod = (cols[idxProduct] || '').toLowerCase();
        if (!prod.includes('heat') && !prod.includes('fioul') && !prod.includes('fod') && !prod.includes('gas oil')) continue;
      }
      if (idxTax >= 0) {
        const tax = (cols[idxTax] || '').toLowerCase();
        // Garder seulement les prix TTC (with taxes)
        if (tax.includes('without') || tax.includes('hors') || tax.includes('ht')) continue;
      }

      const dateStr = cols[idxDate];
      if (!dateStr || !/\d{4}/.test(dateStr)) continue;

      const date = new Date(dateStr);
      if (isNaN(date) || date < sixMoisAgo) continue;

      let val = parseFloat(cols[idxValue]);
      if (isNaN(val) || val <= 0) continue;

      // Les valeurs EU sont en €/1000L → convertir en €/L
      if (val > 10) val = val / 1000;

      prixFioul.push({
        date: date.toISOString().slice(0, 10),
        prix_litre: Math.round(val * 10000) / 10000
      });
    }

    console.log(`${prixFioul.length} entrées France fioul trouvées`);

    if (prixFioul.length === 0) {
      // Le CSV GitHub est peut-être en retard — retourner le cache Supabase
      const existing = await getExistingPrices();
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ source: 'supabase_cache', data: existing, warning: 'Aucune donnée France fioul dans le CSV' })
      };
    }

    // Dédoublonner par date et trier
    const byDate = {};
    prixFioul.forEach(p => { byDate[p.date] = p; });
    const sorted = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));

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
      body: JSON.stringify({ source: 'wob_csv_fresh', data: sorted, count: sorted.length })
    };

  } catch (error) {
    console.error('Erreur:', error.message);
    try {
      const existing = await getExistingPrices();
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ source: 'supabase_cache', data: existing, error: error.message })
      };
    } catch (e2) {
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
