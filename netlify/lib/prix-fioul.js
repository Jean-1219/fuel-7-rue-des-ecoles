// Récupère le prix moyen national du fioul domestique et l'enregistre dans Supabase.
// Partagé par la fonction planifiée (chaque lundi) et la fonction du bouton « Actualiser ».
//
// Source : Weekly Oil Bulletin de la Commission européenne, fichier « Price developments
// 2005 onwards ». Ce sont les prix que la France (DGEC) transmet chaque semaine à l'UE :
// prix TTC du fioul domestique, en €/1000 L, relevés le lundi.
// (fioulmarket.fr, l'ancienne source, renvoie une page sans tableau aux serveurs.)

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

const PAGE_WOB = 'https://energy.ec.europa.eu/data-and-analysis/weekly-oil-bulletin_en';
const FICHIER_WOB = 'https://energy.ec.europa.eu/document/download/906e60ca-8b6a-44e7-8589-652854d2fd3f_en?filename=Weekly_Oil_Bulletin_Prices_History_maticni_4web.xlsx';
const FEUILLE = 'Prices with taxes';
const COLONNE = 'FR_price_with_tax_heating_oil';
const MOIS_GARDES = 12;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

// L'adresse du fichier est stable ; si elle change un jour, on la retrouve sur la page du bulletin.
async function telechargerFichier() {
  let r = await fetch(FICHIER_WOB, { timeout: 20000 });
  if (r.ok) return r.buffer();
  const page = await (await fetch(PAGE_WOB, { timeout: 10000 })).text();
  const m = page.match(/href="([^"]*maticni[^"]*\.xlsx[^"]*)"/i);
  if (!m) throw new Error(`fichier du Weekly Oil Bulletin introuvable (HTTP ${r.status})`);
  const url = new URL(m[1].replace(/&amp;/g, '&'), PAGE_WOB).href;
  r = await fetch(url, { timeout: 20000 });
  if (!r.ok) throw new Error(`téléchargement du Weekly Oil Bulletin refusé (HTTP ${r.status})`);
  return r.buffer();
}

function lirePrix(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', sheets: [FEUILLE] });
  const ws = wb.Sheets[FEUILLE];
  if (!ws) throw new Error(`feuille « ${FEUILLE} » absente du fichier`);
  const lignes = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
  const col = lignes[0] ? lignes[0].indexOf(COLONNE) : -1;
  if (col < 0) throw new Error(`colonne ${COLONNE} absente du fichier`);

  const limite = new Date();
  limite.setMonth(limite.getMonth() - MOIS_GARDES);
  const prix = [];
  for (const l of lignes) {
    const serie = l[0], val = l[col];
    if (typeof serie !== 'number' || typeof val !== 'number' || val <= 0) continue;
    const d = new Date(Math.round((serie - 25569) * 86400000)); // date Excel → date JS
    if (d < limite) continue;
    prix.push({ date: d.toISOString().slice(0, 10), prix_litre: Math.round(val / 1000 * 10000) / 10000 });
  }
  return prix.sort((a, b) => a.date.localeCompare(b.date));
}

async function enregistrer(prix) {
  // on_conflict=date : sans ce paramètre, une date déjà présente provoque une erreur 409
  const r = await fetch(`${SUPABASE_URL}/rest/v1/prix_fioul_dgec?on_conflict=date`, {
    method: 'POST', headers: HEADERS_SB, body: JSON.stringify(prix)
  });
  if (!r.ok) throw new Error(`enregistrement Supabase refusé (HTTP ${r.status}) : ${(await r.text()).slice(0, 200)}`);

  // Retire de la période couverte les anciens prix d'une autre source (relevés quotidiens
  // fioulmarket), pour que la courbe ne mélange pas deux séries différentes.
  const dates = prix.map(p => p.date);
  const filtre = `date=gte.${dates[0]}&date=not.in.(${dates.join(',')})`;
  const d = await fetch(`${SUPABASE_URL}/rest/v1/prix_fioul_dgec?${filtre}`, { method: 'DELETE', headers: HEADERS_SB });
  if (!d.ok) console.warn('Nettoyage des anciens prix impossible :', d.status);
}

async function majPrixFioul() {
  try {
    const prix = lirePrix(await telechargerFichier());
    if (!prix.length) throw new Error('aucun prix France trouvé dans le Weekly Oil Bulletin');
    await enregistrer(prix);
    console.log(`${prix.length} prix enregistrés, dernier : ${prix[prix.length - 1].date}`);
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ source: 'weekly_oil_bulletin', data: prix, count: prix.length })
    };
  } catch (error) {
    console.error('Erreur:', error.message);
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ source: 'supabase_cache', data: [], error: error.message })
    };
  }
}

module.exports = { majPrixFioul };
