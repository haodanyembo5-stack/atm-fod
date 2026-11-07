# ATM FOD

Boutique, services de marketing et de sensibilisation au trading, lecteurs intégrés pour les vidéos YouTube et TikTok compatibles, accès à Netflix sur son site officiel, et fil de publications public avec pièces jointes (photo, vidéo, PDF, audio) et partage de position GPS sur consentement. Les comptes et abonnements restent gérés par les plateformes.

Les raccourcis Amis, Appels, Messages, Live, Services (Marketing, Trading, YouTube, TikTok et Netflix), Profil, Solde, Formation, Localisation, Police et Colis sont regroupés derrière une icône flottante persistante. La position GPS n’est demandée qu’après le clic explicite sur le bouton de partage. Les numéros d’urgence proposés sont indicatifs pour la France/Europe ; ailleurs, utiliser les services locaux. Le suivi transporteur n’est pas encore connecté et les commandes restent des démonstrations. La rubrique Trading est pédagogique : elle ne fournit pas de conseil financier personnalisé et ne permet pas de passer des ordres.

## Démarrer en local

```sh
npm ci
npm start
```

Ouvrir http://localhost:3000. Les publications et les fichiers sont enregistrés dans `data/` et `uploads/`.
Le client PeerJS et son service de signalisation sont servis par la même instance ; aucun script vidéo externe n’est requis.

La recherche et la lecture intégrées YouTube utilisent l’API YouTube Data v3 et nécessitent une clé configurée côté serveur dans `YOUTUBE_API_KEY`. En local, lancer le serveur avec `YOUTUBE_API_KEY="votre-cle" npm start`. Sur Render, ajouter `YOUTUBE_API_KEY` dans les variables d’environnement du service. La clé n’est jamais envoyée au navigateur. Les vidéos doivent autoriser l’intégration pour être lues dans le site.

Le profil public TikTok `@haodaagar` est intégré au moyen de l’embed officiel TikTok et affiche jusqu’à dix de ses vidéos récentes. Les vidéos doivent être accessibles publiquement et TikTok peut appliquer ses propres restrictions d’affichage ou de connexion.

## Firebase Analytics

Le SDK Firebase est regroupé localement à chaque démarrage. Les statistiques restent désactivées tant que le visiteur ne les accepte pas ; son choix peut être modifié via le lien « Cookies » en bas de page. Si Analytics n’est pas pris en charge par le navigateur, le reste du site continue à fonctionner.

Le fichier `firebase-client.js` contient la configuration web publique du projet Firebase. Une clé API web Firebase n’est pas un secret ; restreindre néanmoins ses référents aux domaines de production dans Google Cloud Console et activer Google Analytics pour le projet Firebase.

## Déployer gratuitement sur Render

Le fichier `render.yaml` configure un service Node sur le plan gratuit, sans carte ni disque persistant. Render peut arrêter le service après 15 minutes sans trafic et le redémarrer à tout moment. Les publications et fichiers téléversés sont enregistrés dans le système de fichiers éphémère ; ils peuvent disparaître après une mise en veille, un redémarrage ou un redéploiement. Le plan gratuit dispose aussi d’un quota mensuel d’heures et de bande passante ; une fois les limites atteintes, Render peut suspendre le service ou les nouveaux déploiements. Utiliser un disque persistant pour conserver les données nécessite une offre payante.

Pour publier le site, pousser ce dossier vers un dépôt GitHub ou GitLab, puis dans Render choisir **New > Blueprint** et connecter ce dépôt. Render détectera `render.yaml`, créera le service et fournira son URL HTTPS. Le serveur utilise automatiquement `RENDER_EXTERNAL_URL` pour les URL canoniques, `robots.txt` et `sitemap.xml`. Pour un domaine personnalisé, configurer `SITE_URL` avec son URL HTTPS canonique dans les variables du service Render.

Après le déploiement, vérifier `/api/health`, `/robots.txt` et `/sitemap.xml` sur l’URL publique, puis ajouter le domaine à Google Search Console et Bing Webmaster Tools. Edge, Firefox et Safari accèdent au même site via son URL HTTPS.

## Installer l’application

Le site est une application web progressive (PWA). Une fois déployé en HTTPS, il peut être installé depuis le même domaine et utilise le même serveur Socket.IO que le site web : les personnes connectées depuis un navigateur, Android, iPhone/iPad ou un navigateur de bureau apparaissent dans la même liste en ligne.

- Android : ouvrir le site dans Chrome et choisir « Installer l’application ».
- iPhone/iPad : ouvrir le site dans Safari, toucher Partager, puis « Sur l’écran d’accueil ».
- Windows, macOS et Linux : ouvrir le site dans Chrome ou Edge et choisir « Installer l’application » dans le menu du navigateur.

Le mode hors ligne conserve l’interface de base, mais la présence, les messages, les appels et les publications nécessitent une connexion Internet. La présence mobile peut s’interrompre lorsque le système suspend l’application en arrière-plan. Les appels nécessitent l’autorisation caméra/micro et un site HTTPS. Le bouton Solde reste informatif : aucun système de paiement n’est configuré.

Les profils sont encore déclaratifs : une authentification serveur est nécessaire pour vérifier les identités avant d’attribuer un rôle.