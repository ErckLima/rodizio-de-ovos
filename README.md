# Rodízio de Ovos

Sistema para sortear, toda sexta-feira, duas pessoas responsáveis por comprar
uma cartela de ovos para a semana, avisando pelo WhatsApp (via n8n +
Evolution API) e exibindo o resultado numa página web hospedável no GitHub
Pages.

## Como as peças se encaixam

```
[Página web - GitHub Pages]        [n8n]
   (só front-end, sem backend)       |
        |  lê/escreve                | sexta 08h: sorteia + avisa
        v                            | segunda 08h: lembra
   [Supabase - Postgres]  <----------+
   (pessoas, sorteios, senha)
```

- **Supabase** guarda os dados e é o único lugar com estado. A página web
  (anon key) só consegue *ler* pessoas/sorteios e só consegue *escrever*
  através de funções que conferem a senha de admin dentro do banco — a senha
  nunca fica exposta no código do site.
- **n8n** usa a `service_role key` (secreta, fica só no n8n) para rodar o
  sorteio e ler o último resultado. Isso é feito através de uma função no
  banco (`ovos_perform_weekly_draw`) que já contém toda a regra do rodízio, então
  o workflow do n8n fica simples: aciona a função e manda WhatsApp.
- **Evolution API**: como vocês já têm uma instância configurada, os nós de
  HTTP Request do n8n só precisam da URL/instância/apikey de vocês.

## 1. Configurar o Supabase

> **Não precisa criar um projeto novo.** A conta free do Supabase limita a 2
> projetos, então este schema foi feito para conviver dentro de um projeto
> que você já tem em uso: todas as tabelas e funções usam o prefixo `ovos_`
> (`ovos_people`, `ovos_draws`, `ovos_app_config`, `ovos_admin_login`, etc.),
> então não colidem com nada que já exista lá. Só escolha qual dos seus
> projetos vai hospedar isso.

1. Abra o projeto Supabase escolhido.
2. Vá em **SQL Editor** e rode o conteúdo de [`database/schema.sql`](database/schema.sql) inteiro.
3. Defina a senha de administração (a mesma que será digitada no botão
   "Gerenciar pessoas" do site). Ainda no SQL Editor, rode (troque
   `SUA_SENHA_AQUI`):

   ```sql
   update ovos_app_config
      set admin_password_hash = crypt('SUA_SENHA_AQUI', gen_salt('bf'))
    where id = 1;
   ```

   Não deixe esse comando salvo em nenhum arquivo versionado — rode e
   descarte.
4. Em **Project Settings > API**, anote:
   - `Project URL`
   - `anon public` key (vai para o site)
   - `service_role` key (vai para o n8n — **nunca** coloque essa chave no
     site, ela ignora toda a segurança/RLS)

## 2. Publicar a página web (GitHub Pages)

1. Edite [`config.js`](config.js) com o `Project URL` e a `anon
   public key` do passo anterior.
2. Suba o repositório inteiro para o GitHub (`index.html`, `style.css`,
   `app.js` e `config.js` ficam na raiz de propósito, para o GitHub Pages
   funcionar sem configuração extra).
3. Em **Settings > Pages**, escolha **Deploy from a branch** > branch
   `main` > pasta `/ (root)` e salve.
4. Abra a URL publicada: a tela principal vai mostrar "Nenhum sorteio
   realizado ainda" até que o n8n rode o primeiro sorteio. O botão "⚙️
   Gerenciar pessoas" já funciona para cadastrar gente com a senha definida
   no passo 1.

## 3. Importar os workflows no n8n (v1.123.21)

Os arquivos estão em [`n8n/`](n8n):

- [`1-sorteio-sexta.json`](n8n/1-sorteio-sexta.json) — roda toda sexta às
  08:00, chama `ovos_perform_weekly_draw` no Supabase e manda WhatsApp para os
  dois sorteados. Se não houver pessoas ativas suficientes, manda um alerta
  em vez de quebrar.
- [`2-lembrete-segunda.json`](n8n/2-lembrete-segunda.json) — roda toda
  segunda às 08:00, busca o último sorteio e reenvia o lembrete para os
  mesmos dois.
- [`3-validar-numero.json`](n8n/3-validar-numero.json) — webhook (`POST
  /webhook/ovos`) que o site chama antes de salvar uma pessoa. Recebe
  `{ "number": "5531999999999" }`, confere no Evolution se esse número tem
  WhatsApp ativo e responde `[{ "success": true, "data": [{ "exists": true,
  ... }] }]`. Se `exists` vier `false`, o site bloqueia o cadastro.

Para cada arquivo: **Workflows > Import from File** no n8n. Depois, abra
cada nó de HTTP Request e preencha os placeholders:

| Placeholder | Onde encontrar |
|---|---|
| `SEU-PROJETO.supabase.co` | Project URL do Supabase |
| `COLOQUE_A_SERVICE_ROLE_KEY_AQUI` | service_role key do Supabase (aparece 2x por nó: `apikey` e `Authorization`) |
| `SUA-URL-EVOLUTION` / `SUA_INSTANCIA` | sua instância Evolution já configurada |
| `COLOQUE_SUA_EVOLUTION_APIKEY_AQUI` | apikey da sua instância Evolution |
| `COLOQUE_O_NUMERO_DO_ADMIN_AQUI` (só no workflow de sexta) | número de WhatsApp seu, para receber o alerta de "poucas pessoas ativas" |

Ative (`Active`) os três workflows depois de preencher tudo. Dica: use o
botão **Execute Workflow** manualmente uma vez em cada um para validar antes
de deixar no automático — o de sexta já vai realizar um sorteio de verdade,
então só teste com o banco populado e ciente disso.

> **Sobre o `3-validar-numero.json`:** o endpoint da Evolution usado
> (`/chat/whatsappNumbers/{instancia}`) é o padrão da v2, mas pode variar
> conforme a versão/instalação do seu Evolution. Se o node "Checar numero
> (Evolution)" der erro, confira na documentação da sua instância qual é o
> endpoint de "verificar se número existe no WhatsApp" e ajuste a URL. A
> URL pública do webhook (`https://SEU-N8N/webhook/ovos`) precisa ser
> configurada também em [`config.js`](config.js), no campo
> `WHATSAPP_CHECK_WEBHOOK_URL`.

> Os placeholders ficam direto no corpo/headers do nó por simplicidade. Se
> preferir mais segurança, troque por Credentials do n8n (Header Auth) em
> vez de colar a chave em texto no JSON do workflow.

## Regras implementadas

1. **Cadastro de pessoas** — nome + WhatsApp, feito pela página web
   (protegido por senha).
2. **Sorteio só na sexta**, com aviso na sexta (assim que sorteia) e
   lembrete na segunda — dois workflows separados no n8n.
3. **Sem repetição até fechar o ciclo** — cada pessoa tem a flag
   `drawn_in_cycle`; o sorteio só escolhe entre quem ainda está com
   `false`. Ver `ovos_perform_weekly_draw` em `database/schema.sql`.
4. **Ativar/inativar** — checkbox "Ativo" no cadastro; gente inativa (ex.
   férias) nunca entra no sorteio, mas mantém histórico.
5. **Reinício automático do ciclo** — quando todo mundo ativo já comprou,
   a função reseta a flag de todos e começa um novo ciclo (o número do
   ciclo incrementa e fica visível no site). Se sobrar uma pessoa (número
   ímpar de ativos), ela entra garantida no próximo sorteio antes do
   reset valer para as demais, para não pular ninguém.
6. **Página 100% front-end** — não há nenhum código de servidor; toda
   escrita passa pela API pública do Supabase, protegida por RLS e pelas
   funções com senha.

## Estrutura de arquivos

```
index.html                  página principal (raiz, para o GitHub Pages)
style.css                    estilos e animações
app.js                       lógica (Supabase, sorteio, CRUD)
config.js                     URL + anon key do Supabase (editar antes de publicar)
database/schema.sql          tabelas, RLS e funções (rodar no Supabase)
n8n/1-sorteio-sexta.json     workflow de sexta-feira
n8n/2-lembrete-segunda.json  workflow de segunda-feira
n8n/3-validar-numero.json    webhook de validacao de numero WhatsApp
```
