# Resan, följ med på resan

En enkel sida för vänner och familj. Ingen serverkod, bara statiska filer.

- Reseuppgifterna ligger krypterade i `data.enc.json` (PBKDF2-SHA256 med 600 000 varv, AES-256-CBC och HMAC-SHA256). Sidan låser upp dem i webbläsaren med användarnamn och lösenord.
- Inga dokument, bokningskoder, biljettnummer, adresser eller passuppgifter finns med. Bara flygnummer, tider, städer, hotellnamn och bröllopsdagarna.
- Bygg om: `RESAN_USER=… RESAN_PASS=… python3 build.py` i den här mappen (läser reseplanen från `../resan`).
