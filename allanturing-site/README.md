# allanturing.com

Home page da Alan Turing Inteligência a Serviço de Todos LTDA. Página estática única (`index.html`, logo embutida).

## Publicar na VPS (187.127.7.248)

1. DNS do domínio: registros **A** `@` e `www` apontando para `187.127.7.248`.
2. Na VPS, como root:

```bash
apt-get update && apt-get install -y git
git clone -b claude/zen-hopper-myje89 https://github.com/bemfeitor/flow-mcp.git /opt/site
bash /opt/site/allanturing-site/deploy.sh
```

3. Com o DNS já propagado, ative o HTTPS:

```bash
certbot --nginx -d allanturing.com -d www.allanturing.com
```

## Atualizar depois

```bash
cd /opt/site && git pull && cp allanturing-site/index.html /var/www/allanturing.com/index.html
```
