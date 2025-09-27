const admin = require("firebase-admin");
const mqtt = require("mqtt");
const gTTS = require("google-tts-api"); // npm install google-tts-api
const fs = require("fs");
const path = require("path");
const axios = require("axios"); // npm install axios
const express = require("express");

const serviceAccount = require("./pkm-medreminder-firebase-adminsdk-fbsvc-269f52353d.json");

// === Init Firebase ===
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// === MQTT Connect ===
const client = mqtt.connect("mqtt://broker.emqx.io:1883");

// === Web Server for MP3 ===
const app = express();
app.use("/audio", express.static(path.join(__dirname, "audio"))); // folder mp3
app.listen(3000, () => console.log("🌐 Web server jalan di http://localhost:3000/audio/"));

// === Data ===
let remindersData = [];
let sudahDikirim = new Set();

// === MQTT Connect ===
client.on("connect", () => {
  console.log("📡 Terhubung ke MQTT broker.");

  // Realtime listener untuk reminders
  db.collection("reminders").onSnapshot(async snapshot => {
    const dataDenganNama = await Promise.all(snapshot.docs.map(async doc => {
      const data = doc.data();
      let namaLansia = [], namaObat = [];

      if (Array.isArray(data.lansiaIds)) {
        for (const lansiaId of data.lansiaIds) {
          const lansiaDoc = await db.collection("lansia").doc(lansiaId).get();
          if (lansiaDoc.exists) namaLansia.push(lansiaDoc.data().nama);
        }
      }

      if (Array.isArray(data.obatIds)) {
        for (const obatId of data.obatIds) {
          const obatDoc = await db.collection("obat").doc(obatId).get();
          if (obatDoc.exists) namaObat.push(obatDoc.data().nama);
        }
      }

      return { docId: doc.id, ...data, namaLansia, namaObat };
    }));

    remindersData = dataDenganNama;
    console.log(`📥 Data reminders diperbarui. Jumlah: ${remindersData.length}`);
  });

  // Listener statusIoT
  db.collection("reminders").onSnapshot(snapshot => {
    snapshot.docChanges().forEach(change => {
      if (change.type === "modified") {
        const data = change.doc.data();
        if (data.statusIoT === "OFF") {
          const payload = JSON.stringify({ command: "OFF" });
          client.publish("pkm/alarm", payload, { qos: 1 }, err => {
            if (err) console.error("❌ Gagal kirim MQTT OFF:", err);
            else console.log(`💡 MQTT OFF terkirim untuk reminder ${change.doc.id}`);
          });
        }
      }
    });
  });

  // Timer cek setiap detik
  setInterval(cekAlarm, 1000);
});

// === Fungsi generate & save MP3 ===
async function createTTSFile(text, filename) {
  const url = gTTS.getAudioUrl(text, {
    lang: "id",
    slow: false,
    host: "https://translate.google.com"
  });

  const filePath = path.join(__dirname, "audio", filename);
  const writer = fs.createWriteStream(filePath);

  const response = await axios({
    url,
    method: "GET",
    responseType: "stream"
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on("finish", () => resolve(`http://192.168.1.2:3000/audio/${filename}`));
    writer.on("error", reject);
  });
}

// === Fungsi Cek Alarm ===
async function cekAlarm() {
  const now = new Date();
  const jamSekarang =
    now.getHours().toString().padStart(2, "0") +
    ":" +
    now.getMinutes().toString().padStart(2, "0");
  const detailwaktuSekarang =
    now.getHours().toString().padStart(2, "0") +
    ":" +
    now.getMinutes().toString().padStart(2, "0") +
    ":" +
    now.getSeconds().toString().padStart(2, "0");

  const detikSekarang = now.getSeconds();
  if (detikSekarang === 0) sudahDikirim.clear();
  console.log("🕒 Sekarang:", detailwaktuSekarang);

  remindersData.forEach(async data => {
    if (data.waktu === jamSekarang && !sudahDikirim.has(data.waktu)) {
      const pesanText = `Kepada Lansia ${data.namaLansia}. Waktunya minum obat ${data.namaObat}.`;

      // bikin nama file unik per reminder
      const filename = `${data.docId}.mp3`;
      const mp3Url = await createTTSFile(pesanText, filename);

      // Kirim MQTT ke ESP
      const payload = JSON.stringify({
        command: "ON",
        mp3Url,
        pesan: pesanText,
      });

      client.publish("pkm/alarm", payload, { qos: 1 }, async err => {
        if (err) console.error("❌ Gagal kirim MQTT:", err);
        else {
          console.log("✅ MQTT terkirim:", payload);
          sudahDikirim.add(data.waktu);

          await db.collection("reminders").doc(data.docId).update({ statusIoT: "ON" });
          console.log(`🔥 statusIoT reminder ${data.docId} diupdate ke ON`);
        }
      });
    }
  });
}
