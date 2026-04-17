# STG 環境セットアップ手順

本番と同一サーバー上に staging を相乗りさせる構成。`dev` ブランチへの push で自動デプロイされます。

| 項目 | 本番 | STG |
|---|---|---|
| ドメイン | histmd.saltybullet.com | stg.histmd.saltybullet.com |
| ディレクトリ | /var/www/histmd.saltybullet.com | /var/www/stg.histmd.saltybullet.com |
| systemd service | histmd | histmd-stg |
| ポート | 3101 | 3102 |
| 対象ブランチ | main | dev |
| DB | /var/www/histmd.saltybullet.com/data/weblogseq.db | /var/www/stg.histmd.saltybullet.com/data/weblogseq.db |

## 1. ディレクトリ作成 & git clone

```bash
sudo mkdir -p /var/www/stg.histmd.saltybullet.com
sudo chown -R $USER:$USER /var/www/stg.histmd.saltybullet.com
cd /var/www/stg.histmd.saltybullet.com
git clone git@github.com:KoichiIshiguro/history_by_md.git .
git checkout dev
npm ci
npm rebuild better-sqlite3
mkdir -p data
```

## 2. `.env.local` を配置（本番と別、DB パスは違うものに）

```bash
cat > /var/www/stg.histmd.saltybullet.com/.env.local <<'EOF'
# ── Auth ────────────────────────────────────────
AUTH_SECRET=<本番と別の値を生成: openssl rand -base64 32>
AUTH_GOOGLE_ID=<Google OAuth Client ID>
AUTH_GOOGLE_SECRET=<Google OAuth Client Secret>
NEXTAUTH_URL=https://stg.histmd.saltybullet.com

# ── AI ──────────────────────────────────────────
GEMINI_API_KEY=<既存>
GROQ_API_KEY=<新規、会議録用>
# 既に本番で使っているキーならそのままでもOK（Google側は別のredirect_uriを登録必要）

# ── Pinecone / Voyage (使っていれば) ──────────
PINECONE_API_KEY=...
VOYAGE_API_KEY=...

# ── Port ────────────────────────────────────────
PORT=3102
EOF
chmod 600 /var/www/stg.histmd.saltybullet.com/.env.local
```

**重要**: Google OAuth を使っている場合、Google Cloud Console の OAuth クライアント設定で **Authorized redirect URI に `https://stg.histmd.saltybullet.com/api/auth/callback/google`** を追加してください。

## 3. systemd service を作成

```bash
sudo tee /etc/systemd/system/histmd-stg.service > /dev/null <<'EOF'
[Unit]
Description=WebLogseq STG
After=network.target

[Service]
Type=simple
User=<本番と同じユーザー>
WorkingDirectory=/var/www/stg.histmd.saltybullet.com
Environment=NODE_ENV=production
Environment=PORT=3102
ExecStart=/usr/bin/npx next start -p 3102
Restart=on-failure
RestartSec=3
StandardOutput=append:/var/log/histmd-stg.log
StandardError=append:/var/log/histmd-stg.err.log

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable histmd-stg
```

（本番の `histmd.service` をコピペして PORT と WorkingDirectory だけ書き換えるのが楽です）

## 4. sudoers 設定（deploy ユーザーがパスなし systemctl できるように）

既存の deploy 設定に histmd-stg を追加：

```bash
sudo visudo -f /etc/sudoers.d/histmd-deploy
```

以下の行を追加（本番用の行があれば横に並べる）：

```
<deploy-user> ALL=(ALL) NOPASSWD: /bin/systemctl start histmd-stg, /bin/systemctl stop histmd-stg, /bin/systemctl restart histmd-stg
```

## 5. Nginx 設定

```bash
sudo tee /etc/nginx/sites-available/stg.histmd.saltybullet.com > /dev/null <<'EOF'
server {
    listen 80;
    server_name stg.histmd.saltybullet.com;

    # Let's Encrypt 認証用 (certbot が書き換えます)
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name stg.histmd.saltybullet.com;

    # 証明書パスは certbot 取得後に差し替え
    ssl_certificate /etc/letsencrypt/live/stg.histmd.saltybullet.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/stg.histmd.saltybullet.com/privkey.pem;

    client_max_body_size 30M; # 音声アップロード用 (25MB + 余裕)

    location / {
        proxy_pass http://127.0.0.1:3102;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s; # 文字起こし/清書が長い場合に備えて
        proxy_send_timeout 300s;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/stg.histmd.saltybullet.com /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 6. Let's Encrypt 証明書発行

```bash
sudo certbot --nginx -d stg.histmd.saltybullet.com
```

（対話形式で email・同意を入力。自動更新は cron で設定済みのはず）

## 7. 初回起動

```bash
# workflow での初回デプロイ前に手動で一度ビルドしておくと安全
cd /var/www/stg.histmd.saltybullet.com
npx next build
sudo systemctl start histmd-stg
curl http://127.0.0.1:3102/  # 200が返ればOK
```

## 8. GitHub Actions の確認

- 既存の secrets (`SERVER_HOST`, `SERVER_USER`, `SERVER_SSH_KEY`) をそのまま流用
- `dev` ブランチに push すると `deploy-stg.yml` が発火
- Actions タブでログ確認できる

## トラブルシュート

- `better-sqlite3` で ABI エラー → `npm rebuild better-sqlite3` を実行
- systemd が起動しない → `sudo journalctl -u histmd-stg -n 50`
- HTTP 502 → Next.js が 3102 で上がっているか `ss -tlnp | grep 3102` で確認
- `PORT=3102` が効かない → systemd の `Environment=PORT=3102` と `ExecStart` の `-p 3102` 両方必要

## データベースの注意

- STG DB は **本番とは独立**。最初は空。
- 本番データをコピーしたい場合:
  ```bash
  # 本番を一時停止
  sudo systemctl stop histmd
  cp /var/www/histmd.saltybullet.com/data/weblogseq.db /var/www/stg.histmd.saltybullet.com/data/weblogseq.db
  sudo systemctl start histmd
  sudo systemctl restart histmd-stg
  ```
- WAL/SHM ファイルはコピー不要（SQLite が自動処理）
