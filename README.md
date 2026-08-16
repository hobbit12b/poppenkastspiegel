# Poppenkastspiegel

Minimale test voor live meekijken tijdens een poppenkastvoorstelling met twee iPads.

## Wat deze versie doet
- camera-iPad vraagt alleen cameratoegang
- microfoon staat uit
- geen opnamefunctie
- geen analytics, accounts of cookies
- livebeeld via WebRTC
- handmatige uitwisseling van een startcode en antwoordcode

## Testen
1. Open de website op beide iPads in Safari.
2. Kies op de iPad achter in de klas **Deze iPad is de camera**.
3. Tik op **Start livebeeld** en geef cameratoestemming.
4. Kopieer de startcode naar de kijk-iPad.
5. Kies daar **Op deze iPad wil ik kijken** en plak de startcode.
6. Maak de antwoordcode en geef die terug aan de camera-iPad.
7. Plak die bij **antwoordcode** en tik **Maak verbinding**.

## Waarom nog handmatige codes?
Dit is bewust de eerste testversie. Er wordt nog geen externe signalingdienst gebruikt. Eerst testen we of WebRTC op de gebruikte iPads en het schoolnetwerk goed werkt. Daarna kan een korte tijdelijke koppelcode of QR-koppeling worden toegevoegd via een eigen beveiligde signalingservice.

## Privacy
Deze website slaat geen videobeelden op. Houd er rekening mee dat een browser of apparaat zelf nog screenshots/schermopnames kan maken; een website kan dat niet volledig technisch blokkeren.
