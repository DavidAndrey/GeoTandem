# GeoTandem : comment ça marche vraiment

*Vue d'ensemble technique pour Product Owners et Product Managers. Aucune connaissance en développement ni en cartographie n'est nécessaire. L'objectif est double : comprendre le produit, et pouvoir discuter d'égal à égal avec l'équipe de développement, comprendre ses besoins et ses limites. État du projet au 25 octobre 2026 : les étapes E1, E2 et E3 sont construites ; la validation finale de l'étape E3 (le « gate E3 ») est encore ouverte.*

---

## 1. L'idée en une minute

Poser une question à une carte est difficile. Prenons : « Quelles écoles se trouvent à moins de 500 mètres d'une route principale, dans les communes qui comptent beaucoup d'enfants ? » Pour y répondre dans un système d'information géographique (SIG) classique, il faut traduire cette phrase en couches de données, en jointures, en zones tampon et en filtres. Cette traduction est le vrai obstacle pour un utilisateur métier. Les données elles-mêmes ne le sont pas.

Les modèles de langage (les LLM, comme ChatGPT, Claude ou des modèles open source) savent faire cette traduction. Mais ils créent un autre problème : une carte bien dessinée donne une impression de vérité, même quand la requête sous-jacente est fausse. Un résultat plausible que personne n'a vérifié est pire qu'inutile.

GeoTandem est un **démonstrateur** qui explore ce dilemme. Il propose deux façons de travailler sur les mêmes données :

- **Le mode A, « classique » :** l'utilisateur choisit des couches, pose des filtres, règle l'affichage. Aucun modèle de langage n'est impliqué. Ce mode est complet à lui seul.
- **Le mode B, « avec assistance IA » :** l'utilisateur écrit sa question en langage naturel. Le modèle la traduit en une requête structurée, que l'application exécute.

Le nom dit l'idée : le tandem. L'humain et le modèle pédalent ensemble, et la question centrale est **qui tient le guidon**. Dans GeoTandem, le degré de contrôle humain est un réglage de l'application, pas une décision figée du fabricant.

Un point de cadrage important : c'est un démonstrateur, pas un produit. Il sert à prouver des concepts et à tester une architecture. Il ne vise ni la mise à l'échelle, ni le multi-client, ni la production telle quelle.

---

## 2. Le principe qui structure tout : le modèle propose, le système exécute

Si on ne devait retenir qu'une chose de l'architecture, ce serait celle-ci.

**Le modèle de langage ne touche jamais aux données.** Il ne produit ni carte, ni tableau, ni requête de base de données. Il produit un **objet de requête** : une description structurée et déclarative de l'analyse voulue (quelle couche, quels filtres, quelle relation spatiale, quel tampon, quelle agrégation).

Cet objet est ensuite :

1. **Validé** contre un schéma strict. Une requête invalide est refusée avant toute exécution.
2. **Montré** à l'utilisateur sous une forme lisible, avec une explication de la façon dont le modèle a interprété la question.
3. **Exécuté par l'application**, et par elle seule, dans un moteur d'exécution unique.

Trois propriétés en découlent, et elles sont la raison d'être du produit :

- **Traçabilité :** chaque résultat se ramène à une requête lisible. Pas de magie cachée.
- **Contrôlabilité :** chaque requête peut être vérifiée, refusée ou corrigée avant de tourner.
- **Reproductibilité :** la même requête redonne le même résultat, sans modèle. On peut rejouer une analyse six mois plus tard sans payer un seul appel d'IA.

Pour le PO, cela signifie que **le mode B n'est pas une deuxième application**. C'est un deuxième moyen de remplir le même formulaire. Les boutons et filtres du mode A produisent exactement le même objet de requête que celui que le modèle génère. Une requête créée par l'IA se retrouve donc dans l'interface classique, où l'utilisateur peut la retoucher à la main, et inversement.

---

## 3. Vue d'ensemble de l'architecture

L'application tient dans **un seul conteneur Docker, un seul processus serveur, un seul port**. Pas de service de base de données à installer, pas de serveur web séparé. Un administrateur lance une commande et l'application démarre avec un jeu de données d'exemple (la région Bern-Mittelland, en Suisse).

Le chemin d'une question, de l'écran aux données, ressemble à ceci :

```
Navigateur (React + carte Leaflet)
        │  HTTP / JSON
        ▼
API (FastAPI)  ── droits, niveaux d'assistance, limites, journal
        │
        ├── mode A : l'interface construit l'objet de requête
        │
        └── mode B : construction du prompt ─► connexion au modèle
                                               (local ou externe)
                                                     │
                                    objet de requête proposé par le modèle
                                                     ▼
                         validation (schéma, catalogue, droits, niveau)
                                                     ▼
                     moteur d'exécution ─► base de données (SpatiaLite)
                                                     ▼
                           résultat + empreinte (hash) + journal
```

Les briques, une par une :

- **L'interface web.** Application monopage en React et TypeScript, avec une carte Leaflet, un tableau d'attributs synchronisé avec la carte, un espace de travail pour l'utilisateur et un espace d'administration. Le texte de l'interface est entièrement dans un catalogue de messages (aujourd'hui en allemand), prêt pour d'autres langues.
- **L'API.** Un serveur FastAPI (Python) reçoit les actions. Il vérifie les droits, applique les règles de contrôle humain et orchestre les appels au modèle. **Toutes les règles de sécurité et de contrôle vivent ici, côté serveur, jamais dans l'interface.** Conséquence stratégique : l'étape E4 prévoit d'ouvrir ces mêmes outils à des clients IA externes via le protocole MCP, et ces clients hériteront des mêmes règles.
- **Le schéma de l'objet de requête.** Le contrat central entre l'interface, le modèle et le moteur. Défini une seule fois, versionné comme un fichier du dépôt. Tout en dérive : la validation de la sortie du modèle, la description des outils pour l'IA, les types TypeScript de l'interface.
- **Le moteur d'exécution.** Il traduit l'objet de requête en requête de base de données et l'exécute sous des limites côté serveur. C'est le seul composant qui exécute des requêtes.
- **La base de données.** Par défaut, un simple fichier SpatiaLite (une base SQLite avec des fonctions géographiques). L'application est conçue pour passer plus tard sur PostgreSQL/PostGIS par configuration. Cette bascule est planifiée, pas encore réalisée.
- **La connexion aux modèles.** Une couche d'adaptation fine parle à tout modèle compatible avec l'interface OpenAI : Ollama en local, OpenAI, et l'interface de compatibilité d'Anthropic. L'administrateur déclare des « connexions », locales ou externes, avec clé chiffrée et test de connexion.

Les données importées ne sont jamais envoyées au modèle. Il ne reçoit qu'une **fiche descriptive** des couches (titres, noms et libellés d'attributs, listes de codes), jamais les valeurs des objets. C'est ce qui rend crédible l'usage d'un modèle externe.

---

## 4. Sous le capot : le fonctionnement interne, étape par étape

Cette section donne le vocabulaire et les mécanismes que l'équipe de développement mentionnera dans les discussions. Chaque sous-section se termine par ce que cela implique pour le produit.

### 4.1 L'objet de requête, le cœur du système

L'objet de requête est un document structuré (en JSON) qui décrit une analyse. Il peut contenir :

- une **source** : la couche dont viennent les résultats ;
- une **jointure d'attributs** : rattacher une table de chiffres (par exemple la population) à une couche de communes via une clé commune ;
- un **filtre** (`where`) : un arbre de conditions combinées par ET, OU, NON. Les conditions sont de plusieurs types : comparaison, intervalle, liste de valeurs, recherche de texte, valeur vide, emprise ou zone dessinée sur la carte, proximité d'un objet précis, ou **relation spatiale** avec une autre couche (« à moins de 500 m de », « à l'intérieur de », « en dehors de ») ;
- un **tampon** (zone autour des objets) ;
- une **agrégation** (compter ou résumer par zone) ;
- des **colonnes calculées** (par exemple la distance à la route la plus proche, utile pour expliquer pourquoi un objet est un résultat) ;
- tri, limite, symbologie et type de sortie.

L'ordre d'évaluation est fixe et ne dépend pas de l'ordre d'écriture : source, jointure, filtre, tampon, relation spatiale, agrégation, colonnes, tri. Cela garantit qu'un même document donne toujours le même résultat.

Le schéma a trois versions (v0, v1, v2) et chacune est **strictement additive** : tout document ancien reste valable et donne le même résultat. Pour le PO, c'est une promesse de compatibilité : les sessions et requêtes sauvegardées ne cassent pas quand le produit évolue.

Chaque résultat est livré avec une **empreinte** (hash) de la requête, la version du schéma et la version des données. Deux résultats avec la même empreinte et la même version de données sont identiques.

*Ce que cela implique :* ajouter une capacité d'analyse (un nouvel opérateur spatial, par exemple) n'est pas un petit ajout. Il faut étendre le schéma, le moteur, l'interface classique, la classification des niveaux d'assistance et le prompt du modèle, puis re-mesurer. Quand une équipe dit « ça touche le schéma », cela veut dire « ça touche tout ».

### 4.2 Trois barrières de validation

Une requête proposée par un modèle passe par plusieurs contrôles successifs, du moins cher au plus cher :

1. **Validation de forme.** Le document respecte-t-il le schéma (types, valeurs autorisées, pas de champ inconnu) ?
2. **Validation contre le catalogue.** La couche existe-t-elle, l'attribut existe-t-il, est-il du bon type, le compte a-t-il le droit de le voir ? Une couche masquée est indiscernable d'une couche inexistante, y compris dans les messages d'erreur. Une comparaison d'ordre sur un attribut oui/non est refusée.
3. **Validation « représentable ».** Pour le mode B, la requête doit pouvoir s'afficher dans les contrôles de l'interface : huit conditions au plus dans une requête directe, certains champs seulement, pas de tampon ni de jointure dans la requête directe. Ce que l'interface ne sait pas montrer, le modèle n'a pas le droit de le proposer, parce qu'un humain doit pouvoir le lire et le corriger.

À cela s'ajoutent des **bornes de complexité** (200 conditions au plus, profondeur 20, 1 000 valeurs par liste, 10 000 sommets de géométrie) qui protègent le serveur contre des requêtes fabriquées pour le saturer.

*Ce que cela implique :* quand un développeur dit « le modèle a été refusé par la validation », ce n'est pas un bug mais le mécanisme qui fonctionne. Les refus sont codés et traduits. La question produit est de savoir si le refus est bien expliqué à l'utilisateur.

### 4.3 Le moteur d'exécution et la parité entre bases de données

Le moteur ne contient aucun SQL écrit à la main. Il assemble une requête à l'aide de SQLAlchemy, qui la « traduit » ensuite dans le dialecte de chaque base. Les fonctions géographiques vraiment différentes entre SpatiaLite et PostGIS passent par un **adaptateur de dialecte** étroit, un par base, afin que la différence reste à un seul endroit.

Règle d'équipe : **une divergence entre deux bases est un défaut, pas une particularité**. D'où les corrections de casse et d'accents (« änggi » trouve « Änggisteibach »), de tri, de segments de tampon (30 par quart de cercle partout) et de typage des clés de jointure. Les opérations spatiales tournent dans la base, pas en Python, pour que la parité soit vérifiable.

Le moteur applique des limites par requête : **10 secondes** de temps d'exécution, **10 000 objets** au plus par résultat, huit requêtes simultanées au total, trois par compte. La base est ouverte en lecture seule pour l'analyse.

*Ce que cela implique :* « 10 000 objets » est un plafond de produit, pas un détail technique. Il tient à un choix de carte : Leaflet dessine sans WebGL, donc les résultats arrivent en GeoJSON dans le navigateur. Un besoin de cent mille objets affichés change la bibliothèque de carte et le mode de livraison des données.

### 4.4 L'import des données

Le chemin d'un fichier (GeoJSON, Shapefile, GeoPackage, CSV, Excel) :

1. dépôt du fichier (200 Mo au plus, 1 Go une fois décompressé) ;
2. lecture dans un **processus enfant isolé**, avec plafonds de mémoire (4 Go d'espace d'adressage), de temps processeur (300 s) et de durée totale (360 s) ;
3. aperçu et reconnaissance des types de colonnes (code maison : une bibliothèque standard comme pandas aurait transformé « 0999 » en 999 et laissé « 3,5 » en texte) ;
4. transformation du système de coordonnées vers le système interne ;
5. création de la table, de l'index spatial, des métadonnées, du journal d'import ;
6. **proposition de listes de codes** à partir des données, que l'administrateur doit confirmer.

Le point 6 est central pour le mode B : une liste de codes non confirmée n'est pas montrée au modèle (voir section 7).

*Ce que cela implique :* l'import est une action d'administrateur, rare, lente et lourde. Ce n'est pas un flux d'ingestion continu. Un besoin de mises à jour fréquentes ou automatiques est une nouvelle exigence.

### 4.5 La fiche des couches : tout ce que le modèle sait de vos données

Pour chaque compte, l'application construit une **fiche** (le « Layer-Steckbrief ») : pour chaque couche visible et autorisée pour le modèle, le titre, la description, le type de géométrie, et pour chaque attribut son nom, son type, son libellé, sa description, son unité, sa plage de valeurs et sa liste de codes confirmée. Elle ne contient **aucune valeur** d'objet, pas même le nombre d'objets.

Cette fiche est mise sous une forme canonique, et son empreinte est enregistrée dans le journal. On sait donc toujours exactement ce que le modèle avait sous les yeux pour une question donnée. Un administrateur peut exclure des couches ou des attributs du modèle.

*Ce que cela implique :* la qualité du produit côté IA dépend de cette fiche (voir section 7). Et la **taille** de la fiche croît avec le nombre de couches et d'attributs, ce qui est le point faible de l'architecture actuelle (voir section 8).

### 4.6 La construction du prompt

Pour une première question en requête directe, le modèle reçoit **deux messages** :

- un message **système** d'environ 20 000 caractères (un peu plus de 5 000 tokens) ;
- un message **utilisateur** qui contient la question, et rien d'autre.

Le message système se compose, dans l'ordre : le texte du niveau d'assistance écrit par l'administrateur (550 caractères), la fiche des couches (4 118 caractères pour les six couches de l'exemple), les règles de format de réponse (1 719), le schéma de réponse en JSON (8 628), puis les règles et sept exemples écrits sur des couches fictives (4 888), enfin une courte mention « première question » (139).

Deux règles de conception pèsent lourd :

- **Le message utilisateur ne contient que la question.** C'est un invariant de sécurité (défense contre l'injection de prompt), couvert par un test. Un texte applicatif ajouté à ce message est interdit, ce qui limite les astuces de rédaction possibles.
- **Les exemples ne parlent que de couches fictives**, parce que le prompt ne doit jamais nommer une couche qu'un compte ne voit pas.

Pour une question de suivi, l'application ajoute au plus six échanges précédents (en mots seulement, jamais de requêtes ni de données), et l'analyse en cours.

La taille est estimée avec un ratio prudent (3 caractères par token) et comparée à la **longueur de contexte** déclarée pour la connexion. Si la somme dépasse, la question est refusée avant tout appel (`context_too_large`). Rien n'est tronqué en silence.

### 4.7 L'appel au modèle et la « sortie contrainte »

Le **contexte** est la quantité maximale de texte (en tokens) qu'un modèle traite en une fois, question, consignes et réponse comprises. En local, il est fixé à 16 384 tokens. L'application réserve 4 000 tokens pour la réponse.

La **sortie contrainte** (`response_format: json_schema`) est un mécanisme où le fournisseur oblige le modèle à produire un JSON conforme au schéma, comme une grammaire. Le schéma est donc envoyé deux fois : comme texte dans le prompt (pour que le modèle le comprenne) et comme contrainte (pour qu'il ne puisse pas s'écarter de la forme).

Les fournisseurs ne se comportent pas pareil, et c'est une source de complexité :

- **Ollama (local)** : la sortie contrainte fonctionne, mais l'ordre des champs du schéma compte.
- **OpenAI** : supporte la sortie contrainte, mais refuse certaines formes de schéma à la racine ; l'adaptateur réemballe et redemande.
- **Anthropic (via la couche de compatibilité)** : la sortie contrainte n'est pas utilisable pour notre schéma récursif ; le schéma ne vaut que comme texte. Pas de mise en cache de prompt via cette couche. Le paramètre de reproductibilité (seed) est ignoré.
- **Modèles « raisonneurs »** : certains renvoient parfois une réponse vide malgré des tokens consommés.

L'adaptateur est volontairement maison et étroit : il filtre les en-têtes sortants, ignore les variables de proxy de l'environnement, et refait au plus deux tentatives. Un framework d'agents aurait caché cette mécanique.

*Ce que cela implique :* « supporter un nouveau fournisseur » n'est jamais « juste changer l'URL ». Chaque fournisseur a ses détours, et le test de connexion et l'évaluation sont les garde-fous.

### 4.8 Le cycle de vie d'une action

Chaque question crée un enregistrement d'**action**, qui sert à la fois de proposition et de journal. Il passe par des statuts : `thinking` (le modèle réfléchit), puis selon le cas `refused` (refusée par l'application), `answered` (le modèle a posé une question ou dit ne pas savoir), `proposed` (en attente de décision), `approved`, `running`, `done`, `applied` (le résultat est l'analyse), `rejected`, `superseded` (remplacée par la question suivante), `undone`, `aborted`, `failed`.

Le serveur répond immédiatement (code 202) avec l'action en `thinking`. L'appel au modèle tourne en arrière-plan, dans un groupe de fils d'exécution séparé, pour qu'un modèle lent ne bloque jamais les requêtes des autres utilisateurs. L'interface interroge régulièrement l'état. Cela permet aussi d'**interrompre** l'appel.

Garde-fous : quatre appels au modèle simultanés au total pour le serveur, **un seul par compte**, un délai maximal par appel (120 s par défaut), un quota quotidien optionnel de requêtes par connexion. Au-delà, le serveur répond « occupé » (503 ou 409).

L'enregistrement fige une photo du niveau et de la connexion tels qu'ils étaient. Modifier le niveau après coup ne réécrit pas l'histoire.

*Ce que cela implique :* « un appel par compte » est une décision de produit qui paraît technique. Elle évite les files d'attente et les états ambigus, mais interdit de lancer deux questions en parallèle.

### 4.9 La chaîne d'outils, telle qu'elle est vraiment construite

Une précision utile : dans GeoTandem, la chaîne d'outils **n'est pas une boucle où le modèle appelle un outil, lit la réponse, puis en appelle un autre**. Elle fonctionne en deux temps :

1. Le modèle fait **un seul appel de planification** qui renvoie la liste complète des étapes, chacune nommant un outil et ses arguments, avec des références aux étapes précédentes par leur numéro.
2. L'application contrôle le plan, puis **exécute les étapes une à une**, chacune comme un objet de requête. Le résultat de la dernière étape est le résultat de la chaîne.

À chaque étape, l'application ne **compte** que les résultats. Aucun objet, aucune valeur, aucun identifiant ne revient au modèle ; il apprend le nombre de résultats et, en cas d'erreur, le code et le nom de ce qui est en cause. Limites : **huit étapes** au plus, **deux replanifications** au plus. Une chaîne qui finit sur un tampon seul est refusée, car l'interface ne saurait pas l'afficher.

Comme chaque étape reste un objet de requête, toute chaîne se réexprime en un objet unique et reste reproductible sans modèle.

### 4.10 Les niveaux d'assistance, concrètement

À chaque modèle d'action, l'application **classe** ce qu'il touche en cinq classes d'opérations : `catalog`, `query`, `spatial`, `derive` (tampon, jointure, agrégation), `display`. Un test parcourt le schéma et échoue si un champ n'a pas de classe, afin qu'aucune future version du schéma n'ajoute une opération non classée.

Le niveau choisi donne, pour chaque classe, l'une de trois valeurs : refusé (la réponse devient une simple proposition à reprendre à la main), validation requise, ou automatique. La case la plus stricte l'emporte. Pour une chaîne, ce sont les classes de **toutes** les étapes qui comptent, pas seulement celles de la dernière requête, pour qu'un tampon ne disparaisse pas dans la composition.

### 4.11 Le fait que tout tourne dans un seul processus

Le serveur est **un seul processus** : les appels au modèle, les exécutions de chaînes, l'évaluation, les verrous (« un appel par compte ») vivent en mémoire de ce processus. C'est ce qui permet « un conteneur, zéro dépendance ». Mais il en résulte :

- **Pas de montée en charge horizontale** : lancer deux instances casserait les verrous et les états en cours.
- **Un redémarrage interrompt les tâches en cours.** Une chaîne en cours s'arrête avec le motif « redémarrage ». Les enregistrements `thinking` trop anciens sont clos comme échoués.
- Les évaluations longues (jusqu'à environ 30 minutes pour les modèles lents) tournent en arrière-plan dans ce même processus, avec suivi par interrogation.

Les alternatives (file de tâches, service séparé) existent et sont courantes, mais elles ajoutent des composants à exploiter. Elles ne se justifient que le jour où l'usage change de nature.

### 4.12 L'évaluation, vue de l'intérieur

L'administrateur a un « banc d'essai » : des **cas** (une question, la réponse attendue exprimée comme résultat), classés en **jeu de réglage** et **jeu de confirmation**. Un **lancement** pose chaque cas plusieurs fois (deux blocs de tirages), note chaque réponse de façon déterministe en comparant les objets retournés, et range le verdict : réussi, faux, refusé, erreur, etc. La **matrice de comparaison** met côte à côte des connexions ou des profils de prompt, avec des statistiques appariées pour dire si l'écart est réel ou du bruit.

Le **profil de prompt** d'une connexion règle le nombre d'exemples (7 ou 12), le placement des consignes, et le mode de sortie (contrainte ou texte seul). Le profil par défaut est le prompt actuel, octet pour octet.

---

## 5. Le contrôle humain comme réglage : les niveaux d'assistance

C'est la partie la plus originale du produit, et celle qui parle le plus aux métiers.

Les premières idées étaient classiques : quatre niveaux globaux, de « l'assistant qui explique » jusqu'à « l'autonome ». Le projet a finalement retenu autre chose, parce que le risque dépend de **l'opération**, pas de la session. Lire une liste de couches est anodin. Exporter des données ne l'est pas.

- L'administrateur définit de **un à quatre niveaux d'assistance**, chacun avec un nom, une description et son propre prompt système.
- Chaque niveau comporte une **matrice par classe d'opération**, avec trois valeurs possibles par case : **refusé**, **validation requise** ou **automatique** (exécution immédiate, visible et annulable).
- Si une requête touche plusieurs classes, **la case la plus stricte l'emporte**.
- Trois niveaux sont livrés : *Assistance* (le modèle explique et propose, l'utilisateur agit seul), *Vérifier* (tout passe par validation, niveau par défaut) et *Automatique* (non sélectionnable par les utilisateurs).

Cette matrice sait exprimer les trois designs envisagés au départ. Et comme tout est appliqué côté serveur, contourner l'interface ne contourne pas la règle.

---

## 6. Deux façons d'obtenir un résultat, au choix de l'utilisateur

**La requête directe.** Le modèle produit un seul objet de requête, complet et lisible. Une étape, une affirmation, peu de surface d'erreur. Adapté aux questions bien délimitées. C'est le chemin mesuré en détail.

**La chaîne d'outils.** Le modèle planifie plusieurs étapes (section 4.9). Plus expressive, notamment pour les tampons, les jointures et les enchaînements, au prix d'un plan à relire. Son évaluation n'est pas encore faite : elle est reportée après le gate E3.

L'application ne choisit pas à la place de l'utilisateur. C'est volontaire : comparer les deux chemins sur la même question est un des enseignements recherchés.

---

## 7. Ce que les mesures ont montré

Les chiffres viennent des essais de développement sur le jeu d'exemple. Ils donnent des ordres de grandeur, pas des garanties pour des données clients.

**Les modèles se classent clairement.** Sur le jeu de réglage de 33 questions :

- Claude Haiku 5.5 : environ 96 % de réussite (98 % sur le jeu de confirmation), environ 0,0013 dollar la question.
- GPT-6 Luna : environ 85 % (88 %), environ 0,0008 dollar la question.
- Gemma 4 12B, modèle local : environ 82 % (85 %), rapide (1,4 s en médiane), sans coût par appel.
- Qwen3 14B, Gemma 4 e4B : environ 76 %.
- Certains modèles locaux sont inutilisables pour cet usage (l'un répond à côté dans 93 cas sur 99).

Un petit modèle local bien choisi tient donc la comparaison avec un modèle externe de milieu de gamme, ce qui valide l'objectif « les données restent dans la maison ». L'écart avec Claude reste réel pour qui accepte le cloud.

**Le bruit est réel.** À température 0,3, deux lancements identiques diffèrent de quelques points. D'où l'insistance sur plusieurs blocs de tirages et la comparaison cas par cas.

**Le point le plus utile pour un PO : les métadonnées comptent plus que le modèle.** On a retiré progressivement de la fiche les descriptions, les libellés, puis les listes de codes. Sans les listes de codes (par exemple « fr » pour français), tous les modèles perdent 66 à 83 réponses justes sur 330, même les meilleurs. Avec un import brut, sans aucune métadonnée, Claude Haiku tombe sous Gemma 4 12B bien renseigné. Confirmer les listes de codes de l'import récupère l'essentiel (Haiku et Luna reviennent presque au niveau de départ). Il reste aux modèles locaux un écart dû aux libellés, qui relient les mots de l'utilisateur aux colonnes (« Anzahl Schulhäuser » ↔ `standorte`).

**Un même prompt ne convient pas à tous les modèles.** Dix variantes de placement et de contenu ont été testées. Aucune ne bat la version de base pour les quatre modèles locaux à la fois. La meilleure variante change selon le modèle. Une phrase ajoutée en un endroit peut faire basculer entièrement un cas sans rapport (de 5 réussites sur 5 à 0 sur 5). D'où l'approche : un prompt commun comme référence, puis un profil par connexion.

**Le danger le plus insidieux : l'erreur silencieuse.** Un modèle peut répondre faux sans le dire. Exemple : une requête sans filtre, alors que l'explication affirme « plus de 10 000 habitants ». Quand on retire les listes de codes, les petits modèles inventent des valeurs sans le signaler, alors que Haiku annonce ses suppositions. Environ deux tiers des mauvaises réponses renvoient zéro résultat, un signal que l'application pourrait détecter. Le verdict « faux en silence » est donc une catégorie à part dans l'évaluation.

---

## 8. Le défi de la longueur du prompt

### 8.1 Le problème

Le prompt pèse environ **5 000 tokens avant même la question**, et ce socle est **renvoyé à chaque question**. Quatre conséquences :

- **Coût et latence.** Chez un fournisseur externe, on paie le texte envoyé à chaque appel. En local, le modèle doit relire ces 5 000 tokens à chaque fois, ce qui pèse sur le temps de réponse et la mémoire de la carte graphique.
- **Marge de contexte.** Avec 16 384 tokens de contexte, 4 000 réservés à la réponse, la marge est correcte pour six couches, mais elle fond avec la taille de la fiche.
- **Attention diluée.** Un modèle qui reçoit beaucoup de consignes en suit moins bien certaines, surtout les petits modèles. C'est le mécanisme derrière les basculements de cas décrits en section 7.
- **Passage à l'échelle de la fiche.** Dans l'exemple, la fiche pèse 4 118 caractères pour six couches, soit environ 700 caractères par couche. À titre d'ordre de grandeur (estimation de ma part, à vérifier avec des données réelles), cinquante couches bien documentées monteraient à plus de 30 000 caractères, soit le triple du prompt actuel pour la fiche seule. C'est le vrai risque de passage aux données clients.

### 8.2 Ce que les mesures disent déjà : la longueur actuelle est « gagnée »

Retirer des morceaux a été testé. Presque toujours, ça coûte :

- **Sans exemples** (variante P1) : les trois modèles locaux les plus petits perdent 29 à 37 réponses justes sur 165. Les exemples portent les petits modèles.
- **Sans les règles** (P4) : Gemma 4 12B et Qwen3.5 9B perdent 10 à 13.
- **Seulement 3 exemples** au lieu de 7 (P6) : tous les modèles locaux perdent.
- **Douze exemples** : gain pour Luna (+13) et Gemma e4B (+5), mais perte pour Qwen3.5 9B (−9). Pas de gagnant commun.
- **Schéma retiré du texte** (P8) : tous perdent, Haiku −62 car il n'a pas de sortie contrainte via la couche de compatibilité.
- **Contexte plus grand** : n'a rien amélioré dans les tests.

Une observation importante : **les modèles forts sont peu sensibles.** Haiku perd 4 réponses sans exemples et rien sans règles. Il pourrait donc recevoir un prompt beaucoup plus court, pour un coût moindre, alors que les petits modèles locaux en ont besoin. C'est un argument direct pour le prompt par connexion.

### 8.3 Les alternatives possibles

| Piste | Ce qu'elle apporte | Limite / risque | Compatible avec les exigences ? |
|---|---|---|---|
| **Cache de prompt** (le fournisseur ou le serveur local réutilise la partie identique d'un appel à l'autre) | Moins de coût et de latence sans toucher au contenu | Ne réduit pas l'attention diluée. Pas disponible via la couche de compatibilité d'Anthropic ; automatique chez OpenAI ; la fiche étant propre à chaque compte, le socle commun doit rester en tête du prompt | Oui |
| **Sélection des couches avant le prompt** (une première étape, par mots-clés, recherche sémantique ou petit appel, choisit les couches pertinentes ; seules celles-ci entrent dans la fiche) | Attaque la vraie croissance du prompt. Indispensable au-delà de quelques dizaines de couches | Si la sélection se trompe, le modèle ne voit pas la bonne couche. Une étape de plus à mesurer. Non construit | Oui, la fiche resterait de métadonnées pures |
| **Exemples choisis dynamiquement** (les 3 ou 4 exemples les plus proches de la question, au lieu de 7 fixes) | Prompt plus court et exemples plus pertinents | Les exemples actuels sont fictifs pour respecter la visibilité des couches. Des exemples sur de vraies couches exigent une génération par compte. C'est la piste P7, reportée à E-7 | Oui, si générés par compte |
| **Prompt allégé pour les modèles forts** (profil par connexion) | Réduit le coût externe sans rien perdre, d'après les mesures (Haiku) | Un prompt de plus à maintenir et à mesurer | Oui ; la mécanique des profils existe depuis E3 |
| **Schéma plus compact** (notation condensée à la place du JSON Schema de 8 600 caractères, ou schéma réduit par type de question) | Le schéma est le plus gros bloc | Non testé. Le retirer entièrement échoue (P8). La contrainte de sortie reste calée sur le vrai schéma | Oui, mais à mesurer |
| **Découper en plusieurs petits appels** (choisir les couches, puis construire les conditions, puis les valeurs) | Chaque appel a un prompt court et ciblé | Plus de latence, plus de coût cumulé, plus de points de défaillance, et un risque de dérive d'une étape à l'autre | Oui |
| **Affiner (fine-tuner) un petit modèle** | Les exemples et règles sortent du prompt, qui devient très court | Exclu par le cadrage du projet (aucun entraînement de modèle) | Non, hors périmètre |
| **Augmenter le contexte** | Simple marge de sécurité | N'a amélioré aucun résultat mesuré, coûte de la mémoire | Oui, mais sans gain démontré |

*Recommandation de lecture :* à court terme, le meilleur rapport gain/effort est le **prompt par connexion** (déjà construit) combiné au **cache de prompt** là où il existe. La **sélection des couches** est le chantier à prévoir avant de brancher des données clients volumineuses. Les exemples dynamiques viennent après, car ils demandent la brique E-7.

Un point d'organisation à ne pas oublier : toute réduction doit passer par le banc d'essai, car les mesures montrent qu'une coupe qui aide un modèle en dégrade un autre.

---

## 9. Les défis rencontrés

### 9.1 Faire confiance sans pouvoir tout vérifier

Un SIG rend les erreurs convaincantes : une carte propre inspire confiance. Le défi n'est pas seulement que le modèle se trompe, mais qu'il se trompe de façon crédible. La réponse architecturale est celle du chapitre 2. La réponse produit est le contrôle humain réglable. Le reste du risque est géré par la mesure (E3) et la chasse aux erreurs silencieuses.

### 9.2 Des résultats identiques sur chaque base de données

Promettre qu'une analyse donne le même résultat sur SpatiaLite et sur PostGIS est plus dur qu'il n'y paraît (casse, accents, tri, arrondis de tampon, typage des clés). Chaque écart est traité comme un défaut. Un banc de tests compare les backends.

### 9.3 Importer des fichiers venus de l'extérieur sans mettre le serveur en danger

Les fichiers sont lus par du code natif (la bibliothèque GDAL notamment). Un fichier piégé ou mal formé peut épuiser la mémoire, boucler ou déclencher un bug. La solution : lecture dans un processus enfant, avec plafonds, et un simple « fichier illisible » côté serveur quoi qu'il arrive. Ce n'est pas un bac à sable de sécurité (l'enfant tourne avec les mêmes droits), mais cela borne les pannes les plus probables.

### 9.4 Le crash intermittent à l'import (risque R1)

C'est le défi le plus récent, et il est instructif parce qu'il n'est pas entièrement élucidé.

**Ce qui s'est passé.** Pendant les tests d'acceptation de l'étape E3, le conteneur s'est arrêté brutalement à plusieurs reprises, avec une corruption de mémoire (« double free or corruption », code de sortie 139). Trois fois sur trois sur une version intermédiaire, puis deux fois sur trois sur un autre lot. Les crashs survenaient quand **plusieurs imports arrivaient en même temps**, en particulier quand les premiers démarraient le « forkserver » (le petit processus qui fabrique les processus enfants de lecture).

**Ce qu'on sait, et ce qu'on ne sait pas.** Le problème apparaît sous concurrence. On ne sait **pas** quelle ligne de code native en est responsable. Des exécutions suivantes ont passé sans problème, ce qui peut tout autant signifier « corrigé » que « chanceux ».

**Ce qui a été décidé.** Supprimer la condition qui déclenche le problème : les lectures sont **sérialisées pour tout le serveur**, un fichier à la fois, avec un verrou qui protège aussi la création du forkserver. Le coût est une attente, acceptable car l'import est une action rare d'administrateur. En complément, le conteneur active un gestionnaire de fautes (`PYTHONFAULTHANDLER=1`) : si le crash revient, la trace de la pile fautive sera enregistrée.

**La leçon.** C'est une décision de risque, pas une correction de cause. Le risque R1 est *contenu*, pas *résolu*. Et la règle qui rend ce choix gratuit (import rare et mono-administrateur) est une hypothèse produit à surveiller.

### 9.5 Un prompt fragile

Un prompt de 20 000 caractères est un objet sensible. Une phrase ajoutée pour corriger un cas peut en casser un autre ailleurs. Règle d'équipe : **une variante de prompt n'est jamais jugée sur les cas pour lesquels elle a été écrite, mais sur l'ensemble.**

### 9.6 Le coût et la durée des évaluations

Une évaluation complète se compte en minutes, jusqu'à une trentaine pour les modèles lents. Elle tourne donc en arrière-plan avec suivi, sans file d'attente. Les prix par question étant connus, une estimation avant lancement est facile.

### 9.7 Garder le scope sous contrôle

Contrats définis avant toute parallélisation, chaque étape présentable seule, rien de construit hors des exigences, vocabulaire commun dans un glossaire. Moins visible que la technique, mais c'est ce qui garde le produit cohérent.

---

## 10. Existe-t-il d'autres approches compatibles avec nos exigences ?

Pour juger les alternatives, voici les exigences qui contraignent le plus le choix :

- le modèle ne touche jamais aux données, et l'exécution est faite par l'application après validation (F-5.9) ;
- aucune opération d'écriture via le chemin IA (F-9.5) ;
- les règles de contrôle humain sont appliquées côté serveur (F-6.7) ;
- le même résultat sur SpatiaLite et PostGIS (F-2.11, F-2.14) ;
- fonctionnement complet sans connexion sortante avec des modèles locaux (F-9.1) ;
- aucune donnée d'objets envoyée à un modèle externe sans accord explicite (F-9.3) ;
- un conteneur, aucune dépendance de service au départ (F-9.7) ;
- tout résultat reproductible sans modèle (F-8.9) ;
- pas d'entraînement de modèle (cadrage de la vision).

Voici comment les alternatives les plus courantes se situent.

**Le modèle écrit directement du SQL (« text-to-SQL »).** *Verdict : incompatible tel quel.* Il faudrait valider le SQL produit, empêcher toute écriture, et assurer la même sémantique sur deux dialectes. On reconstruirait un second langage de requête à valider, avec moins de garanties que l'objet de requête actuel. C'est l'alternative la plus répandue et celle que le projet a explicitement écartée.

**Appel d'outils « natif » en boucle (le modèle appelle un outil, lit le résultat, enchaîne).** *Verdict : compatible.* C'est possible dans le cadre des exigences, à condition de ne renvoyer que des comptages et pas de contenu (F-9.3). La planification en un appel, choisie ici, rend le plan visible et validable avant exécution, et réduit le nombre d'appels. Revers : le modèle ne peut pas s'adapter à un résultat intermédiaire sans replanifier (deux replanifications au plus). La boucle native serait plus souple mais plus chère et plus difficile à auditer, et les modèles locaux y sont moins fiables. Une évaluation de la chaîne (reportée) dira si ce coût se justifie.

**Un framework d'agents du marché (LangChain et équivalents).** *Verdict : compatible, mais contraire à l'intention.* Il apporterait une boucle d'outils clé en main. Le projet veut justement étudier et montrer cette boucle, donc il la garde en interne. Pour un produit, ce serait un choix légitime à rouvrir.

**Un langage de requête réduit, ou des modèles de question par type** (le modèle choisit parmi quelques patrons : « filtrer », « à proximité de », « compter par zone », et ne remplit que des cases). *Verdict : compatible et prometteur.* Le schéma présenté au modèle serait bien plus petit, le prompt plus court, et les erreurs plus rares. On perd en expressivité. Une variante intermédiaire existe déjà dans l'esprit : le schéma montré au modèle est déjà réduit à ce que l'interface peut afficher. Non testé.

**Un calque sémantique** (des indicateurs et des définitions métier, déjà nommés, que le modèle assemble). *Verdict : compatible.* C'est proche de ce que font les requêtes enregistrées partagées (déjà présentes). Les utiliser comme exemples dynamiques ou comme briques serait un bon prolongement, sous réserve de la règle de visibilité des couches.

**Boucle de réparation** (renvoyer l'erreur de validation au modèle pour qu'il corrige). *Verdict : compatible, et à ma connaissance non construite.* Dans le code examiné, les nouvelles tentatives ne concernent que le transport réseau, pas la correction sémantique. Un seul second essai guidé par le message de refus coûterait un appel de plus, mais pourrait récupérer une part des réponses refusées. À mesurer.

**Contrôles sémantiques côté application.** *Verdict : compatible, et le plus rentable contre les erreurs silencieuses.* Signaler « zéro résultat sur une égalité de texte sans liste de codes », ou comparer les conditions de la requête aux hypothèses annoncées par le modèle. Ces contrôles ne dépendent d'aucun modèle. Le premier est repéré comme candidat après E3.

**Un modèle externe puissant partout** (Haiku à 96–98 %). *Verdict : compatible si l'administrateur l'active, mais contraire au défaut de la vision.* La vision pose l'exploitation locale comme normale et le cloud comme exception. Seules des métadonnées partent, jamais de contenu. Une stratégie hybride (local par défaut, externe sur demande, prompt adapté à chacun) est ce que l'architecture permet déjà.

**Un modèle affiné pour la géo.** *Verdict : hors périmètre.* Le cadrage exclut l'entraînement. Choisir un modèle local plus grand ou plus récent reste, lui, parfaitement possible, et c'est précisément ce que le banc d'essai sert à décider.

**Passer tout de suite sur PostGIS.** *Verdict : compatible, plus robuste en production.* Il impose cependant un service de base de données dès le départ. Le démarrage avec SpatiaLite a été choisi pour « un conteneur, une commande », tout en gardant PostGIS ouvert. Pour un vrai déploiement multi-utilisateur, PostGIS devient très vite la bonne réponse.

**Une carte plus moderne (MapLibre, WebGL).** *Verdict : compatible.* Meilleure pour de gros volumes, inutile tant que les résultats sont plafonnés à 10 000 objets. Le choix de Leaflet est aussi dicté par une question de licence de l'alternative la plus répandue.

**Pour le crash à l'import.** On aurait pu garder les imports concurrents et chercher la cause native (long, incertain), déplacer la lecture dans un service séparé ou une file de tâches (plus de composants), l'isoler dans un vrai bac à sable (plus sûr, plus lourd), ou remplacer GDAL par des lecteurs en Python pur (perte de formats). La sérialisation a été préférée parce qu'elle est peu coûteuse, supprime la condition de déclenchement et se défait facilement.

---

## 11. Ce que cela implique pour la suite

Sujets explicitement reportés :

- **L'évaluation de la chaîne d'outils** (seule la requête directe est mesurée aujourd'hui).
- **Les synonymes et valeurs de noms propres dans la fiche** (« Bevölkerung », « Bahnhof »), là où les modèles locaux perdent encore après l'ajout des listes de codes.
- **Un indicateur « zéro résultat »** en exploitation, pour signaler les erreurs silencieuses probables.
- **La correction manuelle de cas** comme source de nouveaux tests.
- **L'ouverture à l'extérieur** : l'application en serveur MCP (étape E4), puis diagrammes et exports (E5), puis client MCP (E6).
- **La bascule vers PostGIS**, comme chantier parallèle.

À ajouter à la liste de réflexion, d'après ce document : la **sélection de couches avant le prompt** (avant de brancher des données volumineuses), le **prompt allégé pour les modèles forts**, et une éventuelle **boucle de réparation**.

Quatre messages à retenir :

1. **Le produit n'est pas un chatbot sur un SIG.** C'est une machine à requêtes vérifiables, avec un contrôle humain réglable, dont l'IA est un des deux guichets d'entrée.
2. **Le choix du modèle compte moins que la qualité des métadonnées.** Le budget le mieux investi sur des données clients est la documentation des couches, en particulier les listes de codes.
3. **La longueur du prompt est un compromis mesuré, pas un oubli.** La couper fait presque toujours perdre de la qualité aux petits modèles. Le vrai risque est la croissance de la fiche avec le nombre de couches.
4. **Ce qui n'est pas encore sûr est dit comme tel.** Le crash à l'import est contenu mais sa cause n'est pas prouvée, et les chiffres de comparaison sont des mesures de développement, à refaire sur les données du client.
