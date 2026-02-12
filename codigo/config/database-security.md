# Segurança do Banco de Dados - Configurações Aplicadas

## Data: Fevereiro/2026

---

## 1. CHECK CONSTRAINT (Ativo)

Impede inserção de roles inválidas.

```sql
ALTER TABLE usuarios
ADD CONSTRAINT check_role_valida
CHECK (role IN ('super_admin', 'usuario', 'admin', 'operador', 'visualizador'));
```

**Teste:**
```sql
-- Isso vai FALHAR:
INSERT INTO usuarios (email, senha_hash, nome, role)
VALUES ('teste@teste.com', 'hash', 'Teste', 'hacker');
-- ERROR: new row for relation "usuarios" violates check constraint "check_role_valida"
```

---

## 2. TRIGGER DE AUDITORIA (Ativo)

Registra todas as alterações de role.

**Tabela de auditoria:** `audit_role_changes`

**Consultar logs:**
```sql
SELECT * FROM audit_role_changes ORDER BY changed_at DESC;
```

**Campos:**
- `usuario_id` - ID do usuário afetado
- `email` - Email do usuário
- `old_role` - Role anterior
- `new_role` - Nova role
- `operation` - INSERT ou UPDATE
- `changed_at` - Data/hora
- `changed_by` - Usuário do banco que fez a alteração
- `client_ip` - IP do cliente

---

## 3. USUÁRIO SEPARADO PARA APLICAÇÃO (Criado)

### Credenciais do usuário app_rastreador:

```
Usuário: app_rastreador
Senha: AppUser@Rastreador2026!Sec
```

### Permissões:
- ✅ SELECT em todas as tabelas
- ✅ INSERT em todas as tabelas
- ✅ UPDATE em todas as tabelas (exceto coluna `role` em `usuarios`)
- ✅ DELETE em todas as tabelas
- ❌ NÃO PODE alterar coluna `role` na tabela `usuarios`

### Para usar (atualizar .env):
```env
# Trocar de:
DATABASE_URL="postgresql://postgres:SENHA@host:5432/rastreador_db"

# Para:
DATABASE_URL="postgresql://app_rastreador:AppUser@Rastreador2026!Sec@host:5432/rastreador_db"
```

### PgBouncer userlist.txt (adicionar):
```
"app_rastreador" "md5641a2a2522c866f35c24c54bb3062c24"
```

---

## 4. ROW LEVEL SECURITY (Ativo para app_rastreador)

### Tabelas protegidas:
- `dispositivos`
- `motoristas`
- `viagens`
- `alarmes`
- `geofences`

### Como funciona:
Cada query filtra automaticamente pela organização do usuário.

### Para usar, setar variável de sessão:
```sql
SET app.current_org_id = '1';
SELECT * FROM dispositivos; -- Só retorna dispositivos da org 1
```

### Integração com Prisma (middleware necessário):

```javascript
// server/middleware/rls.middleware.js
prisma.$use(async (params, next) => {
  // Setar org_id antes de cada query
  if (req.usuario?.organizacao_id) {
    await prisma.$executeRawUnsafe(
      `SET app.current_org_id = '${req.usuario.organizacao_id}'`
    );
  }
  return next(params);
});
```

---

## RESUMO DE STATUS

| Proteção | Status | Ativo Para |
|----------|--------|------------|
| CHECK Constraint | ✅ Ativo | Todos os usuários |
| Trigger Auditoria | ✅ Ativo | Todos os usuários |
| Usuário app_rastreador | ✅ Criado | Precisa trocar no .env |
| RLS | ✅ Ativo | Apenas app_rastreador |

---

## PRÓXIMOS PASSOS (Opcional)

1. **Trocar conexão para app_rastreador**
   - Atualizar DATABASE_URL no .env
   - Atualizar PgBouncer userlist
   - Reiniciar containers

2. **Integrar RLS com Prisma**
   - Criar middleware para setar org_id
   - Testar isolamento entre organizações

3. **Monitorar audit_role_changes**
   - Criar alerta se houver alterações suspeitas
