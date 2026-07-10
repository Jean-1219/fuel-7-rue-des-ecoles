// Fonction Netlify : récupère les prix hebdomadaires du fioul domestique
// Source : fioulmarket.fr (données DGEC republiques, accès libre)

const fetch = require('node-fetch');

const SUPABASE_URL = 'https://tqurezznmkhvzbktwnnz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRxdXJlenpubWtodnpia3R3bm56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2MTg5ODAsImV4cCI6MjA5NjE5NDk4MH0.uBhhMzibGzWmiXoSxfZwLSPiORCjrGmO1TFbtoCWzeU';

const HEADERS_SB = {
  'apikey': SUPABASE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_KEY,
  'Content-Type': 'application/json',
  'Prefer': 'resolution=merge-duplicates'
};

exports.handler = async (event, context) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  try {
    console.log('Scraping fioulmarket.fr...');

    const response = await fetch('https://www.fioulmarket.fr/evolution-prix-fioul', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-FR,fr;q=0.9'
      },
      timeout: 15000
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();

    // Extraire les données JSON intégrées dans la page (chart.js ou script JSON)
    const prixFioul = [];
    const sixMoisAgo = new Date();
    sixMoisAgo.setMonth(sixMoisAgo.getMonth() - 6);

    // Chercher les tableaux de données au format [date, prix] dans les scripts
    const jsonMatches = html.matchAll(/\[["'](\d{4}-\d{2}-\d{2})["'],\s*([\d.]+)\]/g);
    for (const m of jsonMatches) {
      const date = new Date(m[1]);
      if (isNaN(date) || date < sixMoisAgo) continue;
      let prix = parseFloat(m[2]);
      if (isNaN(prix) || prix <= 0) continue;
      if (prix > 10) prix = prix / 1000;
      prixFioul.push({ date: m[1], prix_litre: Math.round(prix * 10000) / 10000 });
    }

    // Fallback : chercher format ["DD/MM/YYYY", prix]
    if (prixFioul.length === 0) {
      const matches2 = html.matchAll(/["'](\d{2})\/(\d{2})\/(\d{4})["'],\s*([\d.]+)/g);
      for (const m of matches2) {
        const dateStr = `${m[3]}-${m[2]}-${m[1]}`;
        const date = new Date(dateStr);
        if (isNaN(date) || date < sixMoisAgo) continue;
        let prix = parseFloat(m[4]);
        if (isNaN(prix) || prix <= 0) continue;
        if (prix > 10) prix = prix / 1000;
        prixFioul.push({ date: dateStr, prix_litre: Math.round(prix * 10000) / 10000 });
      }
    }

    // Fallback 2 : chercher les données dans une variable JS type labels/data
    if (prixFioul.length === 0) {
      const labelsMatch = html.match(/labels\s*[:=]\s*\[([^\]]+)\]/);
      const dataMatch = html.match(/data\s*[:=]\s*\[([^\]]+)\]/);
      if (labelsMatch && dataMatch) {
        const labels = labelsMatch[1].match(/["']([^"']+)["']/g) || [];
        const vals = dataMatch[1].match(/[\d.]+/g) || [];
        labels.forEach((l, i) => {
          const dateRaw = l.replace(/["']/g, '').trim();
          let dateStr = null;
          const mFR = dateRaw.match(/(\d{2})\/(\d{2})\/(\d{4})/);
          const mISO = dateRaw.match(/(\d{4}-\d{2}-\d{2})/);
          if (mFR) dateStr = `${mFR[3]}-${mFR[2]}-${mFR[1]}`;
          else if (mISO) dateStr = mISO[1];
          if (!dateStr) return;
          const date = new Date(dateStr);
          if (isNaN(date) || date < sixMoisAgo) return;
          let prix = parseFloat(vals[i] || '0');
          if (isNaN(prix) || prix <= 0) return;
          if (prix > 10) prix = prix / 1000;
          prixFioul.push({ date: dateStr, prix_litre: Math.round(prix * 10000) / 10000 });
        });
      }
    }

    console.log(`${prixFioul.length} entrées extraites de fioulmarket.fr`);

    if (prixFioul.length < 3) {
      // Insérer au moins le prix du jour manuellement depuis le contenu HTML
      // Chercher un prix type "1,413 €/L" ou "1.413 €/L" ou "1 413 € les 1 000"
      const prixJourMatch = html.match(/(\d[\d\s]*[,.][\d]{3})\s*(?:€\/[Ll]|euros?\s*(?:le|\/)\s*litre)/i)
        || html.match(/prix[^<]{0,50}?(\d[,.][\d]{3})/i);

      if (prixJourMatch) {
        let prixStr = prixJourMatch[1].replace(/\s/g, '').replace(',', '.');
        let prix = parseFloat(prixStr);
        if (!isNaN(prix) && prix > 0) {
          if (prix > 10) prix = prix / 1000;
          const today = new Date().toISOString().slice(0, 10);
          prixFioul.push({ date: today, prix_litre: Math.round(prix * 10000) / 10000 });
          console.log(`Prix du jour extrait : ${prix} €/L`);
        }
      }
    }

    if (prixFioul.length === 0) {
      throw new Error('Impossible d\'extraire des données de fioulmarket.fr');
    }

    // Dédoublonner et trier
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
      console.error('Erreur Supabase:', await upsertRes.text());
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ source: 'fioulmarket_fresh', data: sorted, count: sorted.length })
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
    `${SUPABASE_URL}/rest/v1/prix_fioul_dgec?date=gte.${sixMoisAgo.toISOString().slice(0, 10)}&order=date.asc`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
  );
  if (!r.ok) return [];
  return r.json();
}
