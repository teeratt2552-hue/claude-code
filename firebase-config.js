// Firebase configuration
// วิธีเอา config:
//   1. เข้า https://console.firebase.google.com/
//   2. สร้าง Project (ฟรี) → เปิดใช้ Firestore Database (โหมด production) + Authentication (Anonymous)
//   3. Project Settings ⚙ → General → Your apps → Web app → Firebase SDK snippet → Config
//   4. Copy ค่าข้างล่างมาทับ
//   5. ใน Firestore Rules ตั้งเป็น:
//        rules_version = '2';
//        service cloud.firestore {
//          match /databases/{database}/documents {
//            match /records/{id} {
//              allow read, write: if request.auth != null;
//            }
//            match /meta/{id} {
//              allow read, write: if request.auth != null;
//            }
//          }
//        }
//
// ถ้ายังไม่ได้ตั้งค่า → แอปจะทำงานแบบออฟไลน์ใช้เครื่องเดียวอัตโนมัติ

window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyCTF8Z2HcgRVU6SqJA59erdytLM6RJrqk0",
  authDomain: "expense-app-e6f3c.firebaseapp.com",
  projectId: "expense-app-e6f3c",
  storageBucket: "expense-app-e6f3c.firebasestorage.app",
  messagingSenderId: "902396614419",
  appId: "1:902396614419:web:e297ab6fff8703fed1ace6"
};
