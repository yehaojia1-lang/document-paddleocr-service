create table if not exists public.template_rules (
  id uuid primary key default gen_random_uuid(),
  doc_type text not null default 'other',
  name text not null,
  text text not null,
  source text default 'document-translation-web',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists template_rules_doc_type_idx
  on public.template_rules(doc_type);

alter table public.template_rules enable row level security;

drop policy if exists template_rules_service_all on public.template_rules;

create policy template_rules_service_all
  on public.template_rules
  for all
  using (true)
  with check (true);
