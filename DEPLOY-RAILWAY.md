# Deploy บน Railway

โปรเจกต์นี้แยกเป็น **2 service** ใน Railway project เดียว (ใช้ repo เดียวกัน)

```
GitHub repo ──► Railway project
                ├─ service "bot"      Root Directory = /          → Dockerfile → bun src/index.ts
                └─ service "lavalink" Root Directory = /lavalink  → Dockerfile → Lavalink + youtube plugin
                        ▲
                        └── private network:  lavalink.railway.internal:2333  (ไม่ต้องเปิดโดเมนสาธารณะ)
```

- `bot` ต่อออกไปหา Discord เอง (บอทตัวเดียว)
- `bot` คุยกับ `lavalink` ผ่าน private network ของ Railway เท่านั้น

---

## 0) เตรียมของ

- บัญชี Railway (แนะนำ Hobby — Lavalink เป็น Java กินแรมประมาณครึ่ง GB ขึ้นไป ส่วน Free plan จำกัด 0.5 GB ต่อ service อาจไม่พอ)
- บัญชี GitHub
- Discord: bot **1 ตัว** (`DISCORD_TOKEN`) เชิญเข้าเซิร์ฟเวอร์แล้ว
- Discord Developer Portal → Bot → เปิด **Message Content Intent** (ใช้อ่านชื่อเพลงที่พิมพ์ในห้องเพลง `/earth setup`) — ไม่เปิดบอทจะ login ไม่ผ่าน

> ⚠️ **ห้ามเอา `.env` ขึ้น GitHub** (`.gitignore` กันไว้แล้ว และซิปเวอร์ชันนี้ไม่มี `.env`)
> ถ้าเคยส่ง/อัปโหลดไฟล์ `.env` เดิมไปที่ไหน แนะนำกด Reset Token ของบอทใน Developer Portal
> (และ key อื่น ๆ ที่เคยอยู่ในไฟล์นั้น เช่น Groq / Gemini ที่ตอนนี้ไม่ได้ใช้แล้วก็ควร revoke ด้วย) แล้วใช้ค่าใหม่บน Railway
> รหัส Lavalink เดิมที่เคยอยู่ใน `application.yml` ถูกเอาออกแล้ว — ตอนนี้ตั้งผ่าน env var

---

## 1) ขึ้น GitHub (ตั้งเป็น Private)

```bash
cd <โฟลเดอร์โปรเจกต์>
git init
git add .
git commit -m "Earth music bot"
git branch -M main
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

ก่อน `git add .` ลองเช็กว่าไม่มี `.env` ติดไป: `git status` ต้องไม่เห็นไฟล์ `.env`

## 2) ลงทะเบียน slash command (ทำครั้งเดียว)

คำสั่งผูกกับ Discord application ไม่ผูกกับเครื่องที่รันบอท ถ้าเคยรัน `bun run register` กับโค้ดเวอร์ชันนี้แล้ว ข้ามได้

```bash
cp .env.example .env      # กรอก DISCORD_TOKEN, DISCORD_APP_ID, DISCORD_GUILD_ID
bun install
bun run register
```

ทางเลือก: ตั้ง `REGISTER_COMMANDS_ON_START=true` บน service `bot` ให้ deploy รอบแรก แล้วลบตัวแปรนี้ออก

## 3) สร้าง service `lavalink` ก่อน

1. Railway → **New Project → Deploy from GitHub repo** → เลือก repo
   service แรกที่ได้ (root `/`) จะใช้เป็น `bot` — ยังไม่ต้องรีบ deploy
2. กด **+ Create → GitHub Repo** → เลือก repo เดิมอีกครั้ง เพื่อสร้าง service ที่สอง
3. ตั้งค่า service ที่สอง:
   - **Settings → Source → Root Directory** = `/lavalink`
   - เปลี่ยนชื่อ service เป็น `lavalink` (ตัวพิมพ์เล็ก — ชื่อนี้ถูกอ้างอิงใน variable ของ bot)
4. แท็บ **Variables** ของ `lavalink` เพิ่ม:

   ```
   LAVALINK_SERVER_PASSWORD=<สุ่มยาว ๆ อย่างน้อย 32 ตัวอักษร>
   ```

   สุ่มได้ด้วย `openssl rand -hex 24` หรือ password manager
5. **อย่า** กด Generate Domain (ไม่ต้องเปิดสู่สาธารณะ)
6. Deploy แล้วดู Logs จนเห็นประมาณ `Lavalink is ready to accept connections.`
   (รอบแรกจะดาวน์โหลด youtube-plugin ก่อน ใช้เวลาสักครู่)

## 4) ตั้งค่า service `bot`

เข้า service `bot` → **Variables → RAW Editor** แล้ววางทั้งก้อน (แก้ค่าที่ครอบ `< >`)

```
DISCORD_TOKEN=<token ของบอท>
DISCORD_APP_ID=<application id ของบอท>
DISCORD_GUILD_ID=<guild id>
DC_OWNER_IDS=<discord user id ของคุณ>

LAVALINK_HOST=${{lavalink.RAILWAY_PRIVATE_DOMAIN}}:2333
LAVALINK_PASSWORD=${{lavalink.LAVALINK_SERVER_PASSWORD}}
LAVALINK_SECURE=false
```

สองบรรทัดที่ขึ้นต้น `LAVALINK_` ที่ใช้ `${{ ... }}` เป็น reference variable ของ Railway
ดึงโดเมนภายในและรหัสผ่านจาก service `lavalink` อัตโนมัติ จึงไม่ต้องคัดลอกรหัสผ่านซ้ำ
(ถ้าตั้งชื่อ service ไม่ใช่ `lavalink` ให้แก้ชื่อในสองบรรทัดนี้ให้ตรง)

จากนั้นกด **Deploy** (Railway จะ build จาก `Dockerfile` ที่ root ให้เอง)

**ถ้าจะใช้ห้องเพลง (`/earth setup`):** บอทเก็บห้องที่ตั้งไว้ใน `/app/data/setup.json` แต่ไฟล์ใน container ของ Railway หายทุกครั้งที่ deploy ใหม่ — คลิกขวาที่ว่างบน canvas ของโปรเจกต์ (หรือกด `Ctrl/⌘ + K`) → **Volume** → เลือก service `bot` → ตั้ง Mount Path เป็น `/app/data` (หรือกำหนดโฟลเดอร์เองด้วย `DATA_DIR`)

> **ประวัติเพลงหายหลัง restart?** ไฟล์ `music-history.db` อยู่โฟลเดอร์เดียวกับ `setup.json` — ถ้าไม่มี Volume จะหายทุกครั้งที่ restart/deploy. บอทจะหาโฟลเดอร์เก็บข้อมูลตามลำดับ `DATA_DIR` → mount path ของ Volume (Railway ใส่ตัวแปร `RAILWAY_VOLUME_MOUNT_PATH` ให้เอง) → `./data` ดูใน Logs ตอนบอทเปิด: บรรทัด `[data] folder: ...` ต้องมีวงเล็บ `(Railway Volume ...)` และ `[history] opened — N plays saved so far` ต้องไม่รีเซ็ตเป็น 0 ทุกรอบ ถ้าเห็น `[data] ⚠️` แปลว่ายังไม่ได้ผูก Volume หรือ `DATA_DIR` ชี้ไปนอก Volume

## 5) เช็กว่าทำงาน

Logs ของ `bot` ควรเห็นตามนี้:

```
[earth] starting...
[lavalink] node main ready
[earth] Earth ready — logged in as <ชื่อบอท> (id=...)
```

แล้วทดสอบใน Discord: `/earth setup` ในห้องข้อความที่ต้องการ → เข้า voice channel → พิมพ์ชื่อเพลงในห้องนั้น (ถ้าบอทยังไม่อยู่ในห้องเสียง ต้องเป็นคนใน `DC_OWNER_IDS` หรือสั่ง `/earth join` ก่อน)

---

## แก้ปัญหา

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| `[lavalink] node main error` / `ENOTFOUND lavalink.railway.internal` / `ECONNREFUSED` | เช็กว่า service ชื่อ `lavalink` ตรงตัว, `lavalink` รันอยู่จริง, อยู่ environment เดียวกัน (private network ข้าม environment/project ไม่ได้). Private network ใช้เวลาเริ่มต้นสั้น ๆ หลัง deploy — โค้ดมี retry อยู่แล้ว |
| `lavalink` boot ไม่ขึ้น `Could not resolve placeholder 'LAVALINK_SERVER_PASSWORD'` | ยังไม่ได้ตั้ง `LAVALINK_SERVER_PASSWORD` บน service `lavalink` (ตั้งใจให้ไม่ boot ถ้าไม่มีรหัส) |
| `lavalink` boot ไม่ขึ้นเพราะ bind address | ตั้ง `SERVER_ADDRESS=0.0.0.0` บน service `lavalink` |
| `Lavalink load failed` / `Sign in to confirm you're not a bot` / `All clients failed` | YouTube บล็อก IP ของ datacenter ได้ ดูหัวข้อ YouTube ด้านล่าง |
| บอทเข้าห้องเสียงไม่ได้ / `[lavalink] ... timeout` ตอนขอเพลง | เช็กสิทธิ์ `Connect` + `Speak` ของบอทในห้องเสียง และดูว่า `lavalink` ต่อติด (log `node main ready`) — ถ้า Lavalink ต่อ Discord voice ไม่ได้ ดูหัวข้อ Voice/UDP ด้านล่าง |
| ไม่เห็น slash command | ยังไม่ได้ `bun run register` (command แบบ global อาจใช้เวลาแสดงผลได้ถึงราว 1 ชม.) |
| `lavalink` รีสตาร์ทเอง / OutOfMemory | เพิ่ม `_JAVA_OPTIONS=-Xmx768m` บน `lavalink` และเช็กว่าแผนที่ใช้มี RAM พอ |

### YouTube

- `lavalink/application.yml` ปรับ youtube-plugin เป็น **1.18.2** (รุ่น tag ล่าสุดตอนที่ทำไฟล์นี้) จากเดิม 1.13.3 และเปลี่ยนเวอร์ชันได้ด้วยตัวแปร `YOUTUBE_PLUGIN_VERSION` บน service `lavalink` โดยไม่ต้องแก้ไฟล์
- YouTube เปลี่ยนระบบป้องกันบอทบ่อย และมีรายงานจากชุมชนว่าตั้งแต่ราวต้นเดือนกันยายน 2026 บางช่วงเล่นไม่ได้แม้ใช้รุ่นล่าสุด (ตัวแก้บางส่วนอยู่ใน snapshot ที่ยังไม่ออกเป็น tag) — ดู issue/release ล่าสุดที่ https://github.com/lavalink-devs/youtube-source
- ถ้า IP ของ Railway ถูกบล็อก ลองเปิด OAuth (ใช้บัญชี Google สำรอง ไม่ใช่บัญชีหลัก) โดยตั้งบน service `lavalink`:
  1. `PLUGINS_YOUTUBE_OAUTH_ENABLED=true` แล้ว redeploy
  2. ดู Logs ของ `lavalink` จะมีโค้ดให้ไปกรอกที่ google.com/device
  3. หลังอนุมัติ ใน log จะแสดง refresh token — คัดลอกมาตั้งเป็น `PLUGINS_YOUTUBE_OAUTH_REFRESHTOKEN=<token>` และ `PLUGINS_YOUTUBE_OAUTH_SKIPINITIALIZATION=true`
  (ต้องเก็บ token ไว้ใน env เพราะดิสก์ของ container บน Railway ไม่ถาวร)

### Voice / UDP

Lavalink เป็นฝ่ายเชื่อมต่อ Discord voice (UDP ขาออกจาก service `lavalink` ไปหา Discord) — บอทเองไม่ได้ถือ UDP แล้ว
ถ้าเข้าห้องเสียงไม่ได้ทั้งที่สิทธิ์ครบ ให้ดู log ของ service `lavalink` และลองอัปเดต Lavalink เป็นรุ่นล่าสุด (`FROM ghcr.io/lavalink-devs/lavalink:4`)

---

## ค่าใช้จ่าย

Railway คิดตามการใช้งานจริง (CPU/RAM/ดิสก์/ทราฟฟิกออก) Hobby มีค่าสมาชิกขั้นต่ำ $5/เดือน ซึ่งรวมเครดิตใช้งาน $5
สองบริการที่รันตลอด 24 ชม. (บอท + Lavalink/JVM) อาจเกินเครดิตเล็กน้อย — ดูตัวเลขจริงที่หน้า Usage ใน dashboard และตั้ง usage limit ได้

## ทางเลือกเสริม

- **Watch Paths** (Settings → Source) กัน deploy สองตัวพร้อมกันทุกครั้งที่ push
  - `bot`: `/src/**`, `/package.json`, `/bun.lock`, `/Dockerfile`
  - `lavalink`: `/lavalink/**`
- **Restart policy**: ค่าเริ่มต้นคือ restart เมื่อ crash (จำกัดจำนวนครั้ง) ปรับได้ที่ Settings → Deploy
- อัปเดตบอท: แก้โค้ด → `git push` → Railway deploy ให้อัตโนมัติ (บอทจะออกจาก voice channel อย่างเรียบร้อยตอนถูกสั่งหยุด)
