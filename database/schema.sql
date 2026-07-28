-- ============================================================================
-- Rodizio de Ovos - Schema do Supabase
-- Rode este arquivo inteiro no SQL Editor do seu projeto Supabase.
-- Depois, veja o README.md para o passo de configurar a senha do admin.
--
-- Todos os objetos usam o prefixo "ovos_" de proposito: este schema.sql foi
-- feito para conviver dentro de um projeto Supabase que ja tem outras
-- coisas (conta gratuita limita a 2 projetos), sem colidir com tabelas ou
-- funcoes existentes.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- Tabelas
-- ----------------------------------------------------------------------------

-- Configuracao unica do app: hash da senha de admin + numero do ciclo atual.
create table if not exists ovos_app_config (
  id smallint primary key default 1,
  admin_password_hash text,
  cycle_number int not null default 1,
  constraint ovos_singleton check (id = 1)
);
insert into ovos_app_config (id) values (1) on conflict (id) do nothing;

-- Pessoas cadastradas no rodizio.
create table if not exists ovos_people (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null, -- formato internacional, ex: 5511999999999
  active boolean not null default true,
  drawn_in_cycle boolean not null default false,
  created_at timestamptz not null default now()
);

-- Data ate quando a pessoa fica inativa (ferias/ausencia). Quando nula e
-- active=false, a inativacao e indefinida (ex: pessoa saiu da empresa).
-- Quando preenchida, ovos_reactivate_expired() reativa a pessoa sozinha
-- assim que essa data passa -- sem precisar de cron job.
alter table ovos_people add column if not exists inactive_until date;

-- Data a partir de quando a pessoa DEVE ficar inativa (agendamento de
-- ferias com antecedencia). So faz sentido quando active=true: a pessoa
-- continua participando normalmente ate essa data chegar, e so entao
-- ovos_reactivate_expired() a tira do sorteio sozinha (junto com o
-- inactive_until, se tiver sido definido, pra ela ja voltar sozinha depois).
alter table ovos_people add column if not exists inactive_from date;

-- Historico de sorteios (usado pela pagina principal e pelo lembrete de segunda).
create table if not exists ovos_draws (
  id uuid primary key default gen_random_uuid(),
  draw_date date not null default current_date,
  cycle_number int not null,
  person1_id uuid references ovos_people(id) on delete set null,
  person1_name text not null,
  person1_phone text not null,
  person2_id uuid references ovos_people(id) on delete set null,
  person2_name text not null,
  person2_phone text not null,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Row Level Security
-- Leitura publica de "ovos_people" e "ovos_draws" (a pagina web precisa
-- exibir o sorteio e a lista de pessoas). Escrita NUNCA acontece direto pela
-- tabela: so pelas funcoes abaixo, que validam a senha do admin (ou rodam
-- com a service_role key, no caso do sorteio automatico do n8n).
-- ----------------------------------------------------------------------------

alter table ovos_people enable row level security;
alter table ovos_draws enable row level security;
alter table ovos_app_config enable row level security;

drop policy if exists "ovos_people_select_public" on ovos_people;
create policy "ovos_people_select_public" on ovos_people for select using (true);

drop policy if exists "ovos_draws_select_public" on ovos_draws;
create policy "ovos_draws_select_public" on ovos_draws for select using (true);

-- ovos_app_config nao tem nenhuma policy de select: fica inacessivel via API
-- publica (nem o hash da senha vaza). As funcoes abaixo leem essa tabela
-- porque rodam como o dono da funcao (SECURITY DEFINER), que ignora RLS.

revoke insert, update, delete on ovos_people from anon, authenticated;
revoke insert, update, delete on ovos_draws from anon, authenticated;
revoke all on ovos_app_config from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Sincroniza o status de quem tem ausencia programada, nas duas direcoes:
--   * quem estava ATIVO com inactive_from definido e a data chegou -> fica
--     inativo sozinho (comeco de ferias agendadas com antecedencia);
--   * quem estava INATIVO com inactive_until definido e a data passou ->
--     volta a ficar ativo sozinho (fim das ferias).
-- Chamada no inicio do sorteio semanal e da invalidacao de sorteio, e
-- tambem pelo site sempre que a lista de pessoas ou o status do ciclo sao
-- carregados -- assim ninguem fica com o status errado so porque nenhum
-- sorteio rodou nesse meio tempo.
-- ----------------------------------------------------------------------------

create or replace function ovos_reactivate_expired()
returns void
language sql
security definer
set search_path = public, extensions
as $$
  update ovos_people
     set active = false,
         inactive_from = null
   where active = true
     and inactive_from is not null
     and inactive_from <= current_date;

  update ovos_people
     set active = true,
         inactive_from = null,
         inactive_until = null
   where active = false
     and inactive_until is not null
     and inactive_until < current_date;
$$;

grant execute on function ovos_reactivate_expired() to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Funcoes de administracao (CRUD de pessoas), protegidas por senha
-- Chamadas pelo site estatico usando a anon key + a senha digitada pelo
-- usuario. A senha e conferida dentro do banco via crypt(); nunca fica
-- exposta no codigo do site.
-- ----------------------------------------------------------------------------

create or replace function ovos_admin_login(p_password text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
begin
  select admin_password_hash into v_hash from ovos_app_config where id = 1;
  if v_hash is null then
    return false;
  end if;
  return v_hash = crypt(p_password, v_hash);
end;
$$;

create or replace function ovos_admin_add_person(p_password text, p_name text, p_phone text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
  v_id uuid;
begin
  select admin_password_hash into v_hash from ovos_app_config where id = 1;
  if v_hash is null or v_hash <> crypt(p_password, v_hash) then
    raise exception 'senha invalida';
  end if;
  insert into ovos_people (name, phone) values (trim(p_name), trim(p_phone)) returning id into v_id;
  return v_id;
end;
$$;

drop function if exists ovos_admin_update_person(text, uuid, text, text, boolean);
drop function if exists ovos_admin_update_person(text, uuid, text, text, boolean, date);

create or replace function ovos_admin_update_person(
  p_password text, p_id uuid, p_name text, p_phone text, p_active boolean,
  p_inactive_until date default null, p_inactive_from date default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
begin
  select admin_password_hash into v_hash from ovos_app_config where id = 1;
  if v_hash is null or v_hash <> crypt(p_password, v_hash) then
    raise exception 'senha invalida';
  end if;
  update ovos_people
     set name = trim(p_name),
         phone = trim(p_phone),
         active = p_active,
         -- inactive_from so faz sentido pra quem continua ativo agora (agenda
         -- uma ausencia futura); se ja esta inativo, o inicio ja passou.
         inactive_from = case when p_active then p_inactive_from else null end,
         -- inactive_until so faz sentido se a pessoa esta inativa agora OU
         -- se tem um inicio de ausencia futura agendado (par inicio/fim);
         -- sem nenhum dos dois, nao ha o que guardar.
         inactive_until = case
                             when not p_active then p_inactive_until
                             when p_inactive_from is not null then p_inactive_until
                             else null
                           end
   where id = p_id;
end;
$$;

create or replace function ovos_admin_delete_person(p_password text, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
begin
  select admin_password_hash into v_hash from ovos_app_config where id = 1;
  if v_hash is null or v_hash <> crypt(p_password, v_hash) then
    raise exception 'senha invalida';
  end if;
  delete from ovos_people where id = p_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- Invalida um dos dois sorteados do sorteio atual (ex: a pessoa saiu da
-- empresa e ninguem lembrou de inativar). Inativa a pessoa automaticamente
-- e sorteia um substituto so pra aquela vaga, sem mexer no outro sorteado.
-- ----------------------------------------------------------------------------

create or replace function ovos_admin_invalidate_draw(p_password text, p_draw_id uuid, p_invalid_person_id uuid)
returns table (
  replaced_person_id uuid,
  replacement_id uuid,
  replacement_name text,
  replacement_phone text,
  slot text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
  v_draw record;
  v_slot text;
  v_other_id uuid;
  v_replacement record;
begin
  select admin_password_hash into v_hash from ovos_app_config where id = 1;
  if v_hash is null or v_hash <> crypt(p_password, v_hash) then
    raise exception 'senha invalida';
  end if;

  perform ovos_reactivate_expired();

  select * into v_draw from ovos_draws where id = p_draw_id;
  if not found then
    raise exception 'sorteio nao encontrado';
  end if;

  if v_draw.person1_id = p_invalid_person_id then
    v_slot := 'person1';
    v_other_id := v_draw.person2_id;
  elsif v_draw.person2_id = p_invalid_person_id then
    v_slot := 'person2';
    v_other_id := v_draw.person1_id;
  else
    raise exception 'essa pessoa nao esta neste sorteio';
  end if;

  update ovos_people set active = false where id = p_invalid_person_id;

  -- tenta achar substituto que ainda nao comprou neste ciclo (mantem o
  -- sorteio justo); se ninguem sobrar, aceita repetir alguem como ultimo
  -- recurso, pra correcao nunca travar por falta de gente
  select id, name, phone
    into v_replacement
    from ovos_people
   where active = true
     and drawn_in_cycle = false
     and id <> v_other_id
     and id <> p_invalid_person_id
   order by random()
   limit 1;

  if not found then
    select id, name, phone
      into v_replacement
      from ovos_people
     where active = true
       and id <> v_other_id
       and id <> p_invalid_person_id
     order by random()
     limit 1;
  end if;

  if not found then
    raise exception 'nao ha ninguem ativo disponivel para substituir';
  end if;

  update ovos_people set drawn_in_cycle = true where id = v_replacement.id;

  if v_slot = 'person1' then
    update ovos_draws
       set person1_id = v_replacement.id,
           person1_name = v_replacement.name,
           person1_phone = v_replacement.phone
     where id = p_draw_id;
  else
    update ovos_draws
       set person2_id = v_replacement.id,
           person2_name = v_replacement.name,
           person2_phone = v_replacement.phone
     where id = p_draw_id;
  end if;

  return query select p_invalid_person_id, v_replacement.id, v_replacement.name, v_replacement.phone, v_slot;
end;
$$;

-- ----------------------------------------------------------------------------
-- Funcao do sorteio semanal, chamada pelo n8n (com a service_role key, nunca
-- pela pagina web). Regras:
--   * sorteia 2 pessoas ativas que ainda nao foram sorteadas no ciclo atual;
--   * quando o "pool" de quem falta sortear esvazia, reinicia o ciclo;
--   * se sobrar 1 pessoa (numero impar de ativos), ela entra garantida no
--     sorteio e o ciclo reinicia para as demais. Para nao sobrecarregar
--     sempre a mesma pessoa, quem repete e escolhido entre a dupla do
--     PRIMEIRO sorteio do ciclo que esta terminando (quem esta esperando
--     ha mais tempo desde que comprou), nunca alguem escolhido ao acaso.
-- ----------------------------------------------------------------------------

create or replace function ovos_perform_weekly_draw()
returns table (
  person1_id uuid, person1_name text, person1_phone text,
  person2_id uuid, person2_name text, person2_phone text,
  cycle_number int
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_active_count int;
  v_pool_count int;
  v_cycle int;
  v_p1 record;
  v_p2 record;
  v_leftover record;
  v_first_draw record;
  v_repeat_id uuid;
begin
  perform ovos_reactivate_expired();

  select count(*) into v_active_count from ovos_people where active = true;
  if v_active_count < 2 then
    raise exception 'pessoas ativas insuficientes (minimo 2, atual %)', v_active_count;
  end if;

  select count(*) into v_pool_count from ovos_people where active = true and drawn_in_cycle = false;
  select ovos_app_config.cycle_number into v_cycle from ovos_app_config where id = 1;

  if v_pool_count = 0 then
    -- ciclo completo: reinicia todo mundo e sorteia do zero
    update ovos_people set drawn_in_cycle = false where active = true;
    v_cycle := v_cycle + 1;
    update ovos_app_config set cycle_number = v_cycle where id = 1;

    select id, name, phone into v_p1 from ovos_people where active = true order by random() limit 1;
    update ovos_people set drawn_in_cycle = true where id = v_p1.id;

    select id, name, phone into v_p2 from ovos_people where active = true and drawn_in_cycle = false order by random() limit 1;
    update ovos_people set drawn_in_cycle = true where id = v_p2.id;

  elsif v_pool_count = 1 then
    -- sobrou 1 pessoa que ainda nao comprou neste ciclo: ela entra garantida
    select id, name, phone into v_leftover from ovos_people where active = true and drawn_in_cycle = false limit 1;
    v_p1 := v_leftover;

    -- quem vai "repetir" (comprar de novo tao cedo) e escolhido, de
    -- preferencia, entre a dupla do primeiro sorteio deste ciclo -- essas
    -- sao as pessoas que estao esperando ha mais tempo desde a ultima vez
    -- que compraram, entao repetir com elas e o mais justo possivel.
    select d.person1_id, d.person2_id
      into v_first_draw
      from ovos_draws d
     where d.cycle_number = v_cycle
     order by d.created_at asc
     limit 1;

    v_repeat_id := null;
    if found then
      select id into v_repeat_id
        from ovos_people
       where active = true
         and id <> v_leftover.id
         and id in (v_first_draw.person1_id, v_first_draw.person2_id)
       order by random()
       limit 1;
    end if;

    if v_repeat_id is not null then
      select id, name, phone into v_p2 from ovos_people where id = v_repeat_id;
    else
      -- fallback: ninguem da dupla do primeiro sorteio esta mais ativo
      select id, name, phone
        into v_p2
        from ovos_people
       where active = true and id <> v_leftover.id
       order by random() limit 1;
    end if;

    update ovos_people set drawn_in_cycle = false where active = true and id <> v_leftover.id;
    v_cycle := v_cycle + 1;
    update ovos_app_config set cycle_number = v_cycle where id = 1;

    update ovos_people set drawn_in_cycle = true where id in (v_p1.id, v_p2.id);

  else
    select id, name, phone into v_p1 from ovos_people where active = true and drawn_in_cycle = false order by random() limit 1;
    select id, name, phone into v_p2
      from ovos_people
     where active = true and drawn_in_cycle = false and id <> v_p1.id
     order by random() limit 1;

    update ovos_people set drawn_in_cycle = true where id in (v_p1.id, v_p2.id);
  end if;

  insert into ovos_draws (cycle_number, person1_id, person1_name, person1_phone, person2_id, person2_name, person2_phone)
  values (v_cycle, v_p1.id, v_p1.name, v_p1.phone, v_p2.id, v_p2.name, v_p2.phone);

  return query select v_p1.id, v_p1.name, v_p1.phone, v_p2.id, v_p2.name, v_p2.phone, v_cycle;
end;
$$;

-- ----------------------------------------------------------------------------
-- Permissoes de execucao
-- ----------------------------------------------------------------------------

revoke all on function ovos_perform_weekly_draw() from public, anon, authenticated;
grant execute on function ovos_perform_weekly_draw() to service_role;

grant execute on function ovos_admin_login(text) to anon, authenticated;
grant execute on function ovos_admin_add_person(text, text, text) to anon, authenticated;
grant execute on function ovos_admin_update_person(text, uuid, text, text, boolean, date, date) to anon, authenticated;
grant execute on function ovos_admin_delete_person(text, uuid) to anon, authenticated;
grant execute on function ovos_admin_invalidate_draw(text, uuid, uuid) to anon, authenticated;
