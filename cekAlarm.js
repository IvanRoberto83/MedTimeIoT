const admin = require("firebase-admin");
const mqtt = require("mqtt");
const fs = require("fs");
const https = require("https");
const gTTS = require("google-tts-api"); // npm install google-tts-api
const serviceAccount = require("./pkm-medreminder-firebase-adminsdk-fbsvc-269f52353d.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const client = mqtt.connect("mqtt://broker.emqx.io:1883");

let remindersData = [];
let sudahDikirim = new Set();

// === MQTT Connect ===
client.on("connect", () => {
  console.log("📡 Terhubung ke MQTT broker.");

  // Realtime listener untuk data reminders
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

  // Listener perubahan statusIoT
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

// === Fungsi generate MP3 Google TTS ===
function generateTTS(text, fileName, callback) {
  const url = gTTS.getAudioUrl(text, { lang: 'id', slow: false, host: 'https://translate.google.com' });
  https.get(url, res => {
    const file = fs.createWriteStream(fileName);
    res.pipe(file);
    file.on('finish', () => {
      file.close(callback);
    });
  });
}

// === Fungsi Cek Alarm ===
function cekAlarm() {
  const now = new Date();
  const jamSekarang = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
  const detailwaktuSekarang = now.getHours().toString().padStart(2,'0') + ':' +
                               now.getMinutes().toString().padStart(2,'0') + ':' +
                               now.getSeconds().toString().padStart(2,'0');

  if (![...sudahDikirim].includes(jamSekarang)) sudahDikirim.clear();
  console.log("🕒 Sekarang:", detailwaktuSekarang);

  remindersData.forEach(data => {
    if (data.waktu === jamSekarang && !sudahDikirim.has(data.waktu)) {
      const pesanText = `Waktunya obat! ${data.namaLansia} menggunakan obat ${data.namaObat}`;
      const mp3FileName = "0001.mp3"; // DFPlayer harus pakai format 0001.mp3, 0002.mp3, dll

      // Generate MP3 TTS
      generateTTS(pesanText, mp3FileName, () => {
        console.log(`✅ MP3 TTS siap: ${mp3FileName}`);

        // Kirim MQTT ke ESP
        const payload = JSON.stringify({
          command: "ON",
          mp3: mp3FileName,
          pesan: pesanText,
          lansia: data.namaLansia,
          obat: data.namaObat,
          tanggal: data.tanggal,
          jam: data.waktu
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
      });
    }
  });
}