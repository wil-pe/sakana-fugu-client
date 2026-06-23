# 🐡 Fugu — Client UI pour l'API Sakana AI

Une interface web locale, légère et soignée, pour discuter avec les modèles **Fugu** de [Sakana AI](https://console.sakana.ai). Envoi de **fichiers** (images, PDF, code, texte), **recherche web** intégrée, choix du modèle et de l'effort de raisonnement, historique conservé localement.

L'application tourne entièrement sur votre machine : un petit serveur Node fait office de proxy vers l'API Sakana (votre clé reste côté serveur, jamais exposée au navigateur) et sert l'interface.

---

## ✨ Fonctionnalités

- **Chat en streaming** — les réponses s'affichent au fil de l'eau, rendu Markdown + coloration syntaxique du code.
- **Pièces jointes** :
  - 🖼️ **Images** (`.png`, `.jpg`, `.webp`, `.gif`) → analysées en vision par le modèle.
  - 📄 **PDF** → le texte est extrait automatiquement et transmis au modèle.
  - 📝 **Code & texte** (`.js`, `.py`, `.md`, `.json`, `.csv`, `.txt`, etc.) → injectés dans le contexte.
  - Glisser-déposer, collage d'image (Ctrl/Cmd+V), ou bouton trombone.
- **Recherche web** — activable d'un clic, le modèle peut consulter le web pendant sa réponse (outil natif Sakana).
- **Choix du modèle** : `fugu`, `fugu-ultra`, `fugu-ultra-20260615`.
- **Effort de raisonnement** : `high` ou `max` (xhigh).
- **Instructions système** personnalisables et plafond de tokens réglable (dans ⚙️ Réglages).
- **Suivi des tokens** consommés, affiché en temps réel.
- **Thème clair / sombre** — bascule d'un clic (icône lune/soleil), mémorisée ; suit par défaut le réglage de votre système.
- **Historique local** — vos conversations sont sauvegardées dans le navigateur (localStorage), rien ne part ailleurs.

---

## 🚀 Installation

Pré-requis : **Node.js ≥ 18** (testé sur Node 22).

```bash
# 1. Installer les dépendances
npm install

# 2. Configurer votre clé API
cp .env.example .env
#   puis ouvrez .env et renseignez SAKANA_API_KEY=...
#   (récupérez la clé sur https://console.sakana.ai)

# 3. Lancer
npm start
```

Ouvrez ensuite **http://localhost:3000** dans votre navigateur.

> 💡 Vous pouvez aussi **ne rien mettre dans `.env`** et saisir votre clé directement dans l'interface (⚙️ Réglages → Clé API). Elle sera alors gardée dans votre navigateur pour la session.

---

## 🔧 Configuration (`.env`)

| Variable           | Obligatoire | Défaut                        | Description                                  |
|--------------------|:-----------:|-------------------------------|----------------------------------------------|
| `SAKANA_API_KEY`   | ✅ *(ou via l'UI)* | —                       | Votre clé API Sakana.                        |
| `PORT`             | ❌          | `3000`                        | Port du serveur local.                       |
| `SAKANA_BASE_URL`  | ❌          | `https://api.sakana.ai/v1`    | URL de l'API (à ne changer qu'en cas de besoin). |

---

## 📜 Scripts

```bash
npm start    # démarre le serveur
npm run dev  # démarre avec rechargement auto (node --watch)
```

---

## 🏗️ Comment ça marche

```
Navigateur (interface)  ──►  Serveur Node/Express  ──►  API Sakana (/v1/responses)
     public/                     server.js                  api.sakana.ai
```

- Le serveur expose une petite API locale : `/api/upload` (traitement des fichiers via multer), `/api/chat` (streaming SSE vers Sakana), `/api/test-key`, `/api/health`.
- Il utilise l'endpoint **`/v1/responses`** de Sakana (recommandé, et seul à exposer l'outil `web_search`).
- Le SDK officiel `openai` est employé en mode compatible (l'API Sakana est compatible OpenAI).

### Détails techniques
- Backend : **Express 4**, **multer 2** (upload), **pdf-parse** (extraction PDF), **openai 4** (client), ESM.
- Frontend : HTML/CSS/JS sans build, `marked` + `DOMPurify` (Markdown sûr), `highlight.js` (code).
- Thème « abysses » sombre, responsive, respecte `prefers-reduced-motion`.

---

## ⚠️ Bon à savoir

- L'API Sakana est **sans état** : à chaque message, l'historique complet est renvoyé. C'est géré automatiquement.
- Pour limiter la taille du stockage navigateur, **les pièces jointes ne sont pas conservées après un rechargement de page** — le fil texte reste, mais re-déposez vos fichiers si vous rechargez puis poursuivez une vieille conversation.
- La taille des fichiers est plafonnée (25 Mo / fichier, 12 fichiers, ~200 000 caractères de texte extrait) pour rester raisonnable.
- Votre clé `.env` n'est jamais envoyée au navigateur ; si vous la saisissez dans l'UI, elle reste dans votre `localStorage`.

---

## 📁 Structure

```
sakana-fugu-client/
├── server.js          # serveur Express (proxy + statique)
├── package.json
├── .env.example       # modèle de configuration
├── .gitignore
└── public/
    ├── index.html     # structure de l'interface
    ├── styles.css     # thème
    └── app.js         # logique front (chat, upload, streaming)
```

---

Bon hacking 🐡
