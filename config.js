// Réglages de l'appli — à modifier ici, sans toucher au reste.
window.APP_CONFIG = {
  // Adresse du relais Google (Apps Script) : à coller après le déploiement (voir LISEZ-MOI.md, étape 3).
  // Tant qu'elle est vide, l'appli fonctionne en local sur le téléphone, sans envoi vers le Drive.
  SCRIPT_URL: "https://script.google.com/macros/s/AKfycbyYqbbnDlHVtPHdn36CRdRax-Wq-z9u6O_NHVFtsiyWqD2Ggw2ar_WLDMUTh1BU1IVC/exec",

  // Lots proposés à la connexion (on peut aussi taper un autre lot à la main).
  LOTS: ["SST-398"],

  // Clients / origines proposés dans la liste (champ facultatif). Code | libellé.
  // Laissé vide volontairement : ce dépôt est PUBLIC, aucun nom de client, de fournisseur ou de marque ne doit y figurer.
  // Le champ « Client / origine » reste en saisie libre (ex. le code de la palette Crosslog : DAM, HBE…).
  CLIENTS: [],

  MAX_PHOTOS: 3,        // photos par article
  PHOTO_MAX_SIDE: 1600, // taille max d'une photo en pixels (plus grand côté)
  PHOTO_QUALITY: 0.72   // qualité JPEG (0 à 1)
};
