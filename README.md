# Earth — บอทเปิดเพลง YouTube สำหรับ Discord

บอท Discord **ตัวเดียว** ที่เปิดเพลงจาก YouTube ผ่าน [Lavalink](https://github.com/lavalink-devs/Lavalink)
ขอเพลงด้วยการ **พิมพ์ชื่อเพลง** (หรือวางลิงก์ YouTube / เพลย์ลิสต์) ในห้องเพลง แล้วควบคุมด้วยปุ่มและเมนูใต้ตัวเล่น

- **ไม่มีระบบฟังเสียง / ถอดเสียง / ตอบเป็นเสียง** — บอทไม่ได้ยินและไม่อัดเสียงใคร
- บอทตัวเดียวถือทั้ง slash command, ตัวเล่น (Components V2) และการเชื่อมต่อ voice (Lavalink ส่งเสียงให้เอง)
- สิ่งเดียวที่บันทึกถาวรคือ **ประวัติเพลงที่เล่น** (SQLite) เพื่อให้ขอเพลงซ้ำแล้วได้คลิปเดิม — ปิดได้ด้วย `MUSIC_HISTORY=false`

## ติดตั้ง

ต้องมี [Bun](https://bun.sh) v1.0+ และ Docker (หรือ Java 17+) สำหรับ Lavalink

```bash
# 1) Lavalink server (+ youtube-source plugin)
cd lavalink && docker compose up -d && cd ..

# 2) บอท
bun install
cp .env.example .env     # แล้วกรอกค่า
bun run register         # ลงทะเบียน slash commands (ทำครั้งเดียว)
bun run start
```

- รหัสผ่านของ Lavalink (`LAVALINK_SERVER_PASSWORD` ใน `lavalink/docker-compose.yml`) ต้องตรงกับ `LAVALINK_PASSWORD` ใน `.env`
- ถ้า YouTube เล่นไม่ได้: อัปเดตเวอร์ชัน `youtube-plugin` ใน `lavalink/application.yml` หรือเปิด `oauth`

### Discord Developer Portal

สร้าง application + bot **ตัวเดียว** แล้วเชิญเข้าเซิร์ฟเวอร์ด้วยสิทธิ์ `View Channels`, `Connect`, `Speak`, `Use Application Commands`

- ห้องเพลง (`/earth setup`): ให้บอทมี `Send Messages`, `Embed Links`, `Read Message History`, `Attach Files` ในห้องนั้น (+ `Manage Messages` ถ้าอยากให้บอทลบข้อความที่พิมพ์ขอเพลง)
- ต้องเปิด **Message Content Intent** (Developer Portal → Bot → Privileged Gateway Intents) — ไม่เปิดบอทจะ login ไม่ผ่าน (`Used disallowed intents`)

### .env ที่จำเป็น

| ตัวแปร | ความหมาย |
|---|---|
| `DISCORD_TOKEN`, `DISCORD_APP_ID` | จาก Developer Portal |
| `DISCORD_GUILD_ID` | guild หลัก (fallback เมื่อสั่งจาก DM) |
| `DC_OWNER_IDS` | Discord user ID ที่ใช้คำสั่งเจ้าของได้ (คั่นด้วย `,`) |
| `LAVALINK_HOST`, `LAVALINK_PASSWORD`, `LAVALINK_SECURE` | ที่อยู่ / รหัสผ่านของ Lavalink |

ค่าอื่น ๆ (ทั้งหมดไม่บังคับ) ดู `.env.example`

## ใช้งาน

1. ตั้งห้องเพลงครั้งแรก: พิมพ์ `/earth setup` ในห้องข้อความที่ต้องการ (หรือ `/earth setup channel-id:<id>`)
2. เข้า voice channel แล้ว **พิมพ์ชื่อเพลงในห้องเพลง** — ไม่ต้องมี prefix
   - ไม่มีเพลงเล่นอยู่ = เล่นทันที, มีเพลงเล่นอยู่ = ต่อคิว
   - ถ้าบอทยังไม่อยู่ในห้องเสียง เฉพาะ `DC_OWNER_IDS` ที่พิมพ์แล้วบอทจะตามเข้าห้องให้
3. ควบคุมด้วยปุ่มใต้ตัวเล่น: 🔀 สลับคิว · ⏮ ก่อนหน้า · ⏯ หยุด/เล่นต่อ · ⏭ ข้าม · 🔁 วนซ้ำ · 📋 คิว · 🔉/🔊 ปรับเสียง · ⏹ หยุด · 🕘 ประวัติเพลง
   และเมนูคิว (เลือกเพลง → ▶ เล่นเลย / 🗑 ลบ) — ใช้ได้เฉพาะคนที่อยู่ voice channel เดียวกับบอท (เจ้าของใช้ได้เสมอ)

| คำสั่ง | ทำอะไร |
|---|---|
| `/earth join [channel-id]` | เข้า voice channel (ทุกคนใช้ได้กับห้องที่ตัวเองนั่งอยู่) |
| `/earth leave` | ออก (หยุดเพลง + ล้างคิว) |
| `/earth stop` | หยุดเพลง |
| `/earth status` | ห้องเสียง, เพลงที่เล่นอยู่, จำนวนคิว |
| `/earth stay [hours]` / `unstay` | ปิด/เปิด auto-leave |
| `/earth setup [channel-id]` | ตั้งห้องเพลง (ไม่ใส่ id = ห้องที่พิมพ์คำสั่ง) |
| `/earth unsetup` | ยกเลิกห้องเพลง |
| `/earth help` | รายการคำสั่ง |

alias: `/ej` `/el` `/est` `/estop` `/eh` `/estay` `/eunstay` `/esetup` `/eunsetup` และ `/ear …`
(คำสั่งนอกจาก `join` ใช้ได้เฉพาะ `DC_OWNER_IDS`)

ออกทันทีเมื่อในห้องไม่เหลือคนจริง ๆ (ไม่นับบอท, หน่วง `ALONE_LEAVE_DELAY_MS` default 2 วิ) — `/earth stay` เพื่อข้าม
นอกจากนี้ถ้าอยู่คนเดียวนานเกิน `AUTO_LEAVE_ALONE_MS` (default 5 นาที) ก็ออกเช่นกัน

### ห้องเพลง (`/earth setup`)

- วางลิงก์ YouTube ได้เหมือนพิมพ์ชื่อเพลง: ลิงก์คลิป (`youtube.com/watch?v=…`, `youtu.be/…`, `music.youtube.com`, shorts) เล่นคลิปนั้นตรง ๆ ไม่ค้นหา (ตัด `si=` / `t=` / `list=` ทิ้ง) ส่วนลิงก์เพลย์ลิสต์ (`youtube.com/playlist?list=…`) จะเพิ่มทั้งเพลย์ลิสต์ — ไม่มีเพลงเล่น = เพลงแรกเล่นทันที ที่เหลือต่อคิว จนคิวเต็ม (`MUSIC_MAX_QUEUE`, ค่าเริ่มต้น 50) — ข้ามไลฟ์สดและคลิปที่ยาวเกิน `MUSIC_MAX_MINUTES`
- ข้อความที่พิมพ์จะถูกลบถ้าบอทมีสิทธิ์ Manage Messages (ปิดได้ด้วย `SETUP_DELETE_MESSAGES=false`)
- ตัวเล่นเป็นข้อความเดียวถาวรที่ถูก edit — ไม่มีเพลงก็ไม่ลบ แค่เปลี่ยนเป็นหน้า idle
- ถ้าไม่ตั้งห้องเพลง ตัวเล่นจะโผล่เฉพาะตอนมีเพลง และต้องกำหนด `QUEUE_CHANNEL_ID` ไว้ (ไม่กำหนด = ไม่มีตัวเล่น)
- ค่าที่ตั้งเก็บไว้ที่ `DATA_DIR/setup.json` (default `./data/setup.json`) — บน Railway ต้องผูก Volume ไว้ที่ `/app/data` ไม่งั้นต้อง `/earth setup` ใหม่ทุกครั้งที่ deploy

### ประวัติเพลง (เล่นซ้ำให้ตรงเพลงเดิม)

บอทจำว่าแต่ละเซิร์ฟเวอร์เคยเล่นเพลงอะไรไปแล้ว เก็บใน SQLite ที่ `DATA_DIR/music-history.db` (ใช้ `bun:sqlite` ในตัว Bun ไม่ต้องติดตั้งอะไรเพิ่ม) แล้วใช้ช่วยตอนมีคนขอเพลงซ้ำ:

- ขอด้วยข้อความเดิมอีกครั้ง → เล่นคลิปเดิมที่เคยเล่น แทนที่จะเชื่อผลค้นหา YouTube อันดับแรก ถ้าเคยมีหลายคลิปจะเลือกอันที่ถูกเลือกบ่อยสุด
- ขอแบบ `<เพลง> ของ <ศิลปิน>` ที่ไม่ตรงกับคำขอเดิมเป๊ะ → หาในชื่อคลิปที่เคยเล่น ต้องเจอทั้งชื่อเพลงและศิลปิน
- ขอแค่ชื่อเพลง (ไม่ระบุศิลปิน) → ใช้ประวัติเฉพาะเมื่อชื่อยาวพอ (6 ตัวอักษรขึ้นไป) และตรงกับเพลงที่เคยเล่นแค่เพลงเดียว
- กด ข้าม ภายใน 20 วินาทีแรก = ถือว่าเลือกผิด ระบบลืมคู่ "คำขอ → คลิป" นั้น
- ปุ่ม 🕘 เปิดรายการเพลงที่เคยเล่นทั้งหมด (หน้าละ 25) เลือกเล่นเลยหรือเพิ่มเข้าคิวได้
- เพลงที่ **เข้าคิว** ถูกบันทึก/นับตั้งแต่ตอนเข้าคิวเลย (ไม่ต้องรอให้ถึงคิวเล่น) และไม่นับซ้ำตอนเริ่มเล่น — เพลงที่ถูกลบออกจากคิวทีหลังก็ยังอยู่ในประวัติ
- ถ้าเปิดฐานข้อมูลไม่ได้ บอทยังทำงานได้ตามปกติ แค่ค้นหา YouTube ทุกครั้ง

ไฟล์อยู่ในโฟลเดอร์ที่เลือกตามลำดับ `DATA_DIR` → mount path ของ Railway Volume (`RAILWAY_VOLUME_MOUNT_PATH`) → `./data` ตอนบอทเปิดจะมี log `[history] opened — N plays saved so far` ถ้า restart แล้วเลขนี้เป็น 0 ตลอด แปลว่าโฟลเดอร์ไม่ได้อยู่บน Volume

ที่เก็บ: ชื่อคลิป ช่อง ความยาว ลิงก์ ข้อความคำขอ Discord user id ของคนขอ และเวลาที่เล่น

## Deploy บน Railway

ดูขั้นตอนเต็มใน [DEPLOY-RAILWAY.md](DEPLOY-RAILWAY.md) — bot และ Lavalink เป็น 2 service
(`Dockerfile` ที่ root = bot, `lavalink/Dockerfile` = Lavalink) ค่า config ทั้งหมดตั้งผ่าน env var

## พัฒนา

```bash
bun test
bun run typecheck
```

## License

MIT
