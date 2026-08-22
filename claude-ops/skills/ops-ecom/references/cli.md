# CLI/API reference

## CLI/API Reference

### Shopify Admin REST API

| Endpoint                                             | Method | Description          |
| ---------------------------------------------------- | ------ | -------------------- |
| `/admin/api/2024-10/shop.json`                       | GET    | Store info and plan  |
| `/admin/api/2024-10/orders.json?status=any&limit=50` | GET    | Recent orders        |
| `/admin/api/2024-10/products.json?limit=250`         | GET    | Product catalog      |
| `/admin/api/2024-10/customers.json?limit=50`         | GET    | Customer list        |
| `/admin/api/2024-10/themes.json`                     | GET    | Theme list           |
| `/admin/api/2024-10/variants/${ID}.json`             | PUT    | Update variant price |

**Auth header**: `X-Shopify-Access-Token: ${SHOPIFY_TOKEN}`

### ShipBob API (optional)

| Endpoint                                                             | Method | Description       |
| -------------------------------------------------------------------- | ------ | ----------------- |
| `https://api.shipbob.com/1.0/shipment?Status=Processing&PageSize=20` | GET    | Pending shipments |

**Auth header**: `Authorization: Bearer ${SHIPBOB_TOKEN}`

