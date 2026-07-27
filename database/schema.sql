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

create or replace function ovos_admin_update_person(p_password text, p_id uuid, p_name text, p_phone text, p_active boolean)
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
         active = p_active
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
-- Funcao do sorteio semanal, chamada pelo n8n (com a service_role key, nunca
-- pela pagina web). Regras:
--   * sorteia 2 pessoas ativas que ainda nao foram sorteadas no ciclo atual;
--   * quando o "pool" de quem falta sortear esvazia, reinicia o ciclo;
--   * se sobrar 1 pessoa (numero impar de ativos), ela entra garantida no
--     sorteio e o ciclo reinicia para as demais, evitando repetir alguem
--     que acabou de comprar.
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
begin
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

    update ovos_people set drawn_in_cycle = false where active = true and id <> v_leftover.id;
    v_cycle := v_cycle + 1;
    update ovos_app_config set cycle_number = v_cycle where id = 1;

    select id, name, phone into v_p2
      from ovos_people
     where active = true and drawn_in_cycle = false and id <> v_leftover.id
     order by random() limit 1;

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
grant execute on function ovos_admin_update_person(text, uuid, text, text, boolean) to anon, authenticated;
grant execute on function ovos_admin_delete_person(text, uuid) to anon, authenticated;
