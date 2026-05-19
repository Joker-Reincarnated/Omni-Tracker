![OmniTracker Console Header](https://i.ibb.co/3yKLWw0K/1008094768.jpg)


# 🛰️ How to Setup Your Phone Tracker (Easy Guide)

This tool helps you find your phone if it gets lost or stolen. It sends the phone's live location straight to your private Telegram app. 

Follow this simple, step-by-step guide to set it up. No coding skills needed!

---

## 📱 Step 1: Download the App on Your Phone

First, install the tracker app on the Android phone you want to plant the tracker.

> 📦 **[Click Here to Download the App](https://tracker.com/download)**

---

## 💬 Step 2: Get Your Free Telegram Setup

We need to create a private system that sends the location maps directly to you.

### 🔹 A. Create Your Tracking Bot
1. Open your Telegram app and search for **`@BotFather`** (look for the blue verified checkmark).
2. Type and send: `/newbot`
3. Give your bot a name (example: `MyFinderBot`).
4. Give it a username that ends in "bot" (example: `joker_finder_bot`).
5. **BotFather** will send you a long code called a **Token**. Copy this code and keep it safe!

*( https://i.ibb.co/1tLkLVf2/1008095038.jpg )*

### 🔹 B. Get Your Personal User ID (UID)
1. In Telegram, search for **`@userinfobot`**.
2. Type and send: `/start`
3. It will reply with a number called your **Id**. Copy this number!

https://i.ibb.co/Q3m1d0s0/1008095062.jpg

---

## 🛠️ Step 3: Copy and Host the Server

Now we put the tracker online using a free hosting service called **Vercel**.

1. Look at the top right of this GitHub page and click the **Fork** button to make your own copy of this project.
2. Go to **[Vercel.com](https://vercel.com)** and sign up for a free account using your GitHub login.
3. On your Vercel dashboard, click **Add New** then click **Project**.
4. Find this project name in the list and click **Import**.

⚠️ **STOP here before clicking Deploy!** We must hide your private keys first.

---

## 🔒 Step 4: Hide Your Private Details

To make sure nobody else can see your tracking information, we hide your keys inside Vercel's secure settings. 

On the Vercel setup page, click on **Environment Variables** and add these 3 things exactly like this:

### ⚙️ Required Configurations Table

| Key Name | What to Paste in the Value Box |
| :--- | :--- |
| **`BOT_TOKEN`** | Paste the long token code you got from `@BotFather`. |
| **`CHAT_ID`** | Paste the ID number you got from `@userinfobot`. |
| **`AUTH_TOKEN`** | Type any secret password you want! (Example: `mysecret99`). **Remember this!** |

*(Place image for Vercel environment variables setup here)*

Now, click the big **Deploy** button. Wait 1 minute, and Vercel will give you a live website link (example: `https://your-name.vercel.app`).

---

## 📲 Step 5: Link Your Phone App

Open the tracker app you downloaded on your phone in **Step 1** and type in your deployment details:

* 🌐 **Vercel URL:** Paste the live link Vercel just gave you.
* 🔑 **Authorization Key:** Type the exact secret password you made up in Step 4.

Tap the **Deploy Configurations** button to link them together.

---

## 🗺️ How to Check Your Phone's Location

Your setup is done! If you ever lose your phone, you can track it instantly in two different ways:

### 🤖 1. Via Telegram
Open your personal bot chat window on Telegram and type `/menu`. Use the dynamic screen buttons to fetch live telemetry or drop a direct Google Maps pin.

### 📊 2. Via Your Web Browser
Open any web browser and visit your Vercel link with `/view` added to the very end:
> **`https://your-name.vercel.app/view`**

This opens a clean, dark terminal dashboard showing your phone's current battery life, network state, and map coordinates.
