// Fonction planifiée : chaque lundi à 8 h (voir netlify.toml).
// Une fonction planifiée ne peut pas être appelée par une adresse web : le bouton « Actualiser »
// passe donc par prix-fioul-maj.js, qui fait exactement le même travail.
const { majPrixFioul } = require('../lib/prix-fioul');
exports.handler = async () => majPrixFioul();
