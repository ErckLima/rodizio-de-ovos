-- ============================================================================
-- Rodizio de Ovos - Reset de ciclo
-- Rode no SQL Editor do Supabase sempre que quiser zerar o historico de
-- testes e comecar o rodizio "pra valer" com o ciclo 1.
--
-- Isso NAO mexe na senha de admin (ovos_app_config.admin_password_hash)
-- nem nas funcoes/tabelas -- so limpa dados.
-- ============================================================================

-- 1) Apaga todo o historico de sorteios (inclusive os de teste)
delete from ovos_draws;

-- 2) Zera quem ja foi "sorteado" neste ciclo, pra todo mundo poder
--    ser sorteado de novo a partir do ciclo 1
update ovos_people set drawn_in_cycle = false;

-- 3) Reinicia o contador de ciclo
update ovos_app_config set cycle_number = 1 where id = 1;

-- 4) OPCIONAL: descomente a linha abaixo se tambem quiser apagar as
--    pessoas cadastradas (ex: as de teste, com telefone no formato antigo
--    com DDI) e comecar o cadastro 100% do zero.
-- delete from ovos_people;
