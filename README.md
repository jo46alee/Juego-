# TrendShopX GameFi — V1

Juego espacial web full-stack, propietario y preparado para evolucionar a GameFi/Web3.

## Incluye
- Registro e inicio de sesión con JWT.
- Planeta inicial y producción automática de Metal, Cristal y Deuterio.
- Edificios: Mina de Metal, Mina de Cristal, Sintetizador de Deuterio y Planta de Energía.
- Mejoras con costes crecientes.
- Misiones con recompensas.
- Marketplace P2P interno con comisión configurable del 3%.
- Wallet interna con TSX y USDT en modo simulado.
- Libro mayor de movimientos.
- Ranking de jugadores.
- Panel administrativo básico.
- Docker y SQLite para arrancar sin servicios externos.
- Arquitectura preparada para reemplazar el modo simulado por blockchain real.

## Ejecutar localmente
```bash
cp .env.example .env
npm install
npm run dev
```
Abrir http://localhost:3000

## Docker
```bash
docker compose up --build
```

## Seguridad
No almacena seed phrases ni claves privadas. Los depósitos/retiros blockchain reales no están activados en V1; existe una capa de servicio para integrar un proveedor después.

## Roadmap
V1 juego/economía -> V2 flotas/combate/alianzas -> V3 Web3 real -> V4 contratos y economía avanzada.
