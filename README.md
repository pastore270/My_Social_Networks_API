# My Social Networks API v2.0.0

API REST pour gérer les événements et les groupes d’un réseau social. Le projet couvre les huit modules du cahier des charges et le bonus covoiturage. Les routes sont préfixées par `/api/v2`.

## Démarrer dans VS Code

Prérequis : Node.js 20 ou supérieur et une instance MongoDB 7 ou supérieure. Ouvre le dossier du projet dans VS Code, puis utilise son terminal PowerShell.

```powershell
npm ci
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Copie la valeur générée dans `JWT_SECRET` dans le fichier `.env`. 
Renseigne `MONGODB_URI` avec l’URI de ton cluster Atlas, suivie du nom de la base `social_networks`.


Lance `npm run dev` dans le terminal . L’API écoute sur `http://localhost:3000`. Envoie `GET http://localhost:3000/health` pour vérifier sa connexion à MongoDB.

## Essayer l’API dans Postman


| Module | Routes principales |
| --- | --- |
| Utilisateurs | `/users`, `/auth/login` |
| Groupes | `/groups` |
| Événements | `/events`, `/events/:eventId/options`, `/events/:eventId/publish` |
| Discussions | `/groups/:groupId/threads`, `/events/:eventId/threads`, puis `/messages` et `/comments` |
| Albums | `/events/:eventId/albums`, puis `/photos` et `/comments` |
| Sondages | `/events/:eventId/polls`, `/events/:eventId/polls/:pollId/answers/me` |
| Billetterie | `/events/:eventId/ticket-types`, `/events/:eventId/tickets` |
| Liste de courses | `/events/:eventId/shopping-items` |
| Covoiturage | `/events/:eventId/rides` |

## Règles implémentées

- **Événements**. La création produit un brouillon. L’organisateur configure les options et publie l’événement. Il peut inviter tous les membres actifs du groupe via les options ou via la route dédiée. Les invitations donnent accès aux activités en tant que participants.
- **Visibilité**. Un groupe privé expose sa fiche et garde la liste des membres privée. Un groupe secret est visible de ses membres. Un événement privé est réservé aux personnes conviées. Un événement public associé à un groupe privé ou secret est accessible aux membres du groupe et aux personnes conviées.
- **Discussions**. Le chemin de la route fixe le parent du fil. Un administrateur peut limiter la création des fils et des messages de groupe. Les membres peuvent commenter un message existant.
- **Sondages**. Chaque participant dispose d’une réponse par sondage. Il envoie un tableau d’indices à partir de zéro, avec une réponse par question. Une nouvelle réponse remplace sa précédente.
- **Billetterie**. Un compte extérieur à l’événement peut réserver un billet au total. Le prix est exprimé en centimes d’euro. La réservation enregistre la date, les coordonnées et le prix au moment de l’achat. Le titulaire et les organisateurs peuvent consulter ses coordonnées. Le module simule la vente, sans prestataire de paiement.
- **Images et partage**. Les photos, icônes et couvertures sont référencées par URL. Les liens de partage utilisent `PUBLIC_BASE_URL`. Pour qu’un visiteur externe puisse ouvrir l’événement partagé, cette URL doit pointer vers une instance accessible publiquement.


## Tests et régénération de la documentation

`npm test` exécute les tests HTTP sur MongoDB. Par défaut, ils utilisent le serveur local sur le port 27017 et créent une base de test isolée qu’ils suppriment à la fin. Pour changer d’instance, définis `TEST_MONGODB_URI` dans ton terminal et utilise un compte autorisé à créer et supprimer cette base de test.

`npm run docs` régénère la collection Postman à partir des routes et de leurs exemples.

## Rendu GitHub ou GitLab

Documentation Postman publiée — lien à ajouter après publication.

Dans Postman, ouvre **View complete documentation**, puis **Publish docs** et **Publish**. Publie avec les valeurs d’exemple de la collection. Copie le lien publié dans ce README. 

Voila la documentation Postman : https://documenter.getpostman.com/view/59274748/2sBYHbrbNX#b9ff8536-b3f0-4984-95c5-7797e68c9abe
