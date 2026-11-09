// Fonction appelée par le bouton « Actualiser » de l'onglet Cours du fioul.
const { majPrixFioul } = require('../lib/prix-fioul');
exports.handler = async () => majPrixFioul();
