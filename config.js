// Preencha com os dados do seu projeto Supabase (Project Settings > API).
// A anon key é pública por natureza — a proteção real está nas policies de
// RLS e nas funções com senha definidas em database/schema.sql.
window.APP_CONFIG = {
  SUPABASE_URL: "https://fsahjrulfwyhttnykjvb.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZzYWhqcnVsZnd5aHR0bnlranZiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxMTIwODcsImV4cCI6MjA5ODY4ODA4N30.vQ1xbEz-i7z0fAW4AEOIrcpQewABhb7NKU0cFZOPg6s",
  // Webhook do n8n que confere se o numero tem WhatsApp ativo antes de salvar
  // (ver n8n/3-validar-numero.json).
  WHATSAPP_CHECK_WEBHOOK_URL: "https://n8n.deverick.cloud/webhook/ovos",
};
