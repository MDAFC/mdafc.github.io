// =====================================================================
// MDAFC – configuration de la base partagée
//
// • Laisser url vide            → mode démo : tout reste sur l'appareil.
// • url: 'mock://local'         → simulation entre onglets (pour tester).
// • Coller les valeurs Supabase → vraie base partagée entre tous les téléphones.
//   (Supabase > Project Settings > API : « Project URL » et clé « anon public ».
//    Cette clé est faite pour être publique : la sécurité vient des règles
//    d'accès du fichier supabase/schema.sql.)
// =====================================================================
window.MDAFC_CONFIG = {
  url: 'https://owokckxeavwzvfgvueuw.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93b2tja3hlYXZ3enZmZ3Z1ZXV3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ2NTE0NzQsImV4cCI6MjExMDIyNzQ3NH0.XddEPGW22jfviTxBQ_Cq2_9WXDJ3Nsa3ER_6h88QIzM'
};

// Pour tester la synchronisation sans Supabase : ouvrir l'application avec « ?mock » à la fin de l'adresse.
if (/[?&]mock\b/.test(location.search)) window.MDAFC_CONFIG = { url: 'mock://local', anonKey: '' };
