// Fonction Netlify : récupère les prix hebdomadaires du fioul DGEC
// Source : fichier Excel officiel DGEC (URL stable, mis à jour chaque lundi)

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

// URL stable du fichier Excel DGEC — prix depuis janvier 2020, mis à jour chaque lundi
const DGEC_URL = 'https://www.ecologie.gouv.fr/sites/default/files/documents/Prix%20HTT%20et%20TTC%20depuis%20janvier%202020_0.xlsx';

exports.handler = async (event, context) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  try {
    console.log('Téléchargement du fichier DGEC...');

    const response = await fetch(DGEC_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FuelTracker/1.0)' },
      timeout: 20000
    });

    if (!response.ok) {
      throw new Error(`Échec téléchargement DGEC : HTTP ${response.status}`);
    }

    const buffer = await response.buffer();
    console.log(`Fichier téléchargé : ${buffer.length} octets`);

    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    console.log('Feuilles disponibles :', workbook.SheetNames);

    let prixFioul = [];

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

      let dateCol = -1, fioulCol = -1, headerRow = -1;

      // Chercher la ligne d'en-tête
      for (let i = 0; i < Math.min(rows.length, 30); i++) {
        const row = rows[i];
        if (!row) continue;
        for (let j = 0; j < row.length; j++) {
          const cell = String(row[j] || '').toLowerCase().trim();
          if (cell.includes('date') || cell.includes('semaine') || cell.includes('période')) dateCol = j;
          if (cell.includes('fioul') || cell.includes('fod') || cell.includes('fuel') || cell.includes('combustible')) fioulCol = j;
        }
        if (dateCol >= 0 && fioulCol >= 0) { headerRow = i; break; }
      }

      console.log(`Feuille "${sheetName}" : dateCol=${dateCol}, fioulCol=${fioulCol}, headerRow=${headerRow}`);
      if (headerRow < 0) continue;

      // Filtrer sur les 6 derniers mois
      const sixMoisAgo = new Date();
      sixMoisAgo.setMonth(sixMoisAgo.getMonth() - 6);

      for (let i = headerRow + 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row[dateCol] === null || row[fioulCol] === null) continue;

        let dateVal = row[dateCol];
        let prix = parseFloat(row[fioulCol]);
        if (isNaN(prix) || prix <= 0) continue;

        // Convertir la date
        let dateStr = null;
        if (dateVal instanceof Date) {
          dateStr = dateVal.toISOString().slice(0, 10);
        } else if (typeof dateVal === 'number') {
          const d = XLSX.SSF.parse_date_code(dateVal);
          if (d) dateStr = `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
        } else if (typeof dateVal === 'string') {
          // Format JJ/MM/AAAA ou JJ-MM-AAAA
          const m = dateVal.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
          if (m) {
            const y = m[3].length === 2 ? '20' + m[3] : m[3];
            dateStr = `${y}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
          }
        }

        if (!dateStr) continue;
        if (new Date(dateStr) < sixMoisAgo) continue;

        // Le prix DGEC fioul TTC est en c€/L → convertir en €/L
        if (prix > 10) prix = prix / 100;

        prixFioul.push({ date: dateStr, prix_litre: Math.round(prix * 10000) / 10000 });
      }

      if (prixFioul.length > 0) {
        console.log(`${prixFioul.length} entrées trouvées dans la feuille "${sheetName}"`);
        break;
      }
    }

    if (prixFioul.length === 0) {
      console.warn('Aucune donnée parsée depuis le fichier DGEC, retour cache Supabase');
      const existing = await getExistingPrices();
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ source: 'supabase_cache', data: existing }) };
    }

    // Dédoublonner par date (garder le dernier)
    const byDate = {};
    prixFioul.forEach(p => { byDate[p.date] = p; });
    prixFioul = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));

    // Upsert dans Supabase
    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/prix_fioul_dgec`, {
      method: 'POST',
      headers: HEADERS_SB,
      body: JSON.stringify(prixFioul)
    });

    if (!upsertRes.ok) {
      console.error('Erreur Supabase upsert:', await upsertRes.text());
    } else {
      console.log(`${prixFioul.length} entrées upsertées dans Supabase`);
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ source: 'dgec_fresh', data: prixFioul, count: prixFioul.length })
    };

  } catch (error) {
    console.error('Erreur générale:', error.message);
    try {
      const existing = await getExistingPrices();
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ source: 'supabase_cache', data: existing, error: error.message }) };
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
