// Récupère les prix du fioul depuis fioulmarket.fr et les enregistre dans Supabase.
// Partagé par la fonction planifiée (chaque lundi) et la fonction appelée par le bouton « Actualiser ».

const fetch = require('node-fetch');

const SUPABASE_URL = 'https://tqurezznmkhvzbktwnnz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRxdXJlenpubWtodnpia3R3bm56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2MTg5ODAsImV4cCI6MjA5NjE5NDk4MH0.uBhhMzibGzWmiXoSxfZwLSPiORCjrGmO1TFbtoCWzeU';

const HEADERS_SB = {
  'apikey': SUPABASE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_KEY,
  'Content-Type': 'application/json',
  'Prefer': 'resolution=merge-duplicates'
};

// Correspondance jours FR → numéro
const JOURS = { lundi:1, mardi:2, mercredi:3, jeudi:4, vendredi:5, samedi:6, dimanche:0 };
const MOIS = { janvier:0, février:1, mars:2, avril:3, mai:4, juin:5, juillet:6, août:7, septembre:8, octobre:9, novembre:10, décembre:11 };

function parseDateFR(str) {
  // Format : "Lundi 13 juillet 2026"
  // \p{L} accepte les lettres accentuées (février, août, décembre), contrairement à \w
  const m = str.toLowerCase().match(/([\p{L}]+)\s+(\d{1,2})(?:er)?\s+([\p{L}]+)\s+(\d{4})/u);
  if (!m) return null;
  const moisNum = MOIS[m[3]];
  if (moisNum === undefined) return null;
  const d = new Date(Date.UTC(parseInt(m[4]), moisNum, parseInt(m[2])));
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

async function majPrixFioul() {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  try {
    console.log('Scraping fioulmarket.fr/evolution-prix-fioul...');

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

    const prixFioul = [];
    const sixMoisAgo = new Date();
    sixMoisAgo.setMonth(sixMoisAgo.getMonth() - 6);

    // Parser le tableau HTML : <td>Lundi 13 juillet 2026</td><td>1502€</td>
    const trMatches = html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
    for (const trMatch of trMatches) {
      const tds = [...trMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
        .map(m => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
      if (tds.length < 2) continue;

      const dateStr = parseDateFR(tds[0]);
      if (!dateStr) continue;

      const date = new Date(dateStr);
      if (isNaN(date) || date < sixMoisAgo) continue;

      // Prix format "1502€" ou "1 502€" ou "1502 €"
      const prixRaw = tds[1].replace(/\s/g, '').replace('€', '').replace(',', '.');
      let prix = parseFloat(prixRaw);
      if (isNaN(prix) || prix <= 0) continue;

      // Convertir €/1000L → €/L
      if (prix > 10) prix = prix / 1000;

      prixFioul.push({ date: dateStr, prix_litre: Math.round(prix * 10000) / 10000 });
    }

    console.log(`${prixFioul.length} entrées extraites du tableau HTML`);

    // Fallback : chercher aussi le prix affiché en gros "1502€/1000L"
    if (prixFioul.length === 0) {
      const bigPrixMatch = html.match(/(\d[\d\s]+)€\/1000L/);
      if (bigPrixMatch) {
        let prix = parseFloat(bigPrixMatch[1].replace(/\s/g, '')) / 1000;
        const today = new Date().toISOString().slice(0, 10);
        prixFioul.push({ date: today, prix_litre: Math.round(prix * 10000) / 10000 });
        console.log(`Prix du jour extrait en fallback : ${prix} €/L`);
      }
    }

    if (prixFioul.length === 0) {
      throw new Error('Aucune donnée extraite de fioulmarket.fr');
    }

    // Dédoublonner par date (garder le lundi = prix de référence hebdo)
    // Priorité aux lundis, sinon garder le plus récent
    const byDate = {};
    prixFioul.forEach(p => {
      const d = new Date(p.date);
      const isLundi = d.getDay() === 1;
      if (!byDate[p.date] || isLundi) byDate[p.date] = p;
    });
    const sorted = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));

    console.log(`${sorted.length} entrées après dédoublonnage`);

    // Upsert dans Supabase
    // on_conflict=date : sans ce paramètre, une date déjà présente provoque une erreur 409 et rien n'est enregistré
    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/prix_fioul_dgec?on_conflict=date`, {
      method: 'POST',
      headers: HEADERS_SB,
      body: JSON.stringify(sorted)
    });

    if (!upsertRes.ok) {
      const txt = await upsertRes.text();
      console.error('Erreur Supabase:', txt);
      throw new Error(`Enregistrement Supabase refusé (HTTP ${upsertRes.status}) : ${txt.slice(0, 200)}`);
    } else {
      console.log(`${sorted.length} entrées upsertées dans Supabase`);
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ source: 'fioulmarket_html', data: sorted, count: sorted.length })
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
}

module.exports = { majPrixFioul };

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
