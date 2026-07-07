'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

loadEnv(path.join(__dirname, '.env'));

const DATA_DIR = path.join(__dirname, 'data');
const PROCESSED_FILE = path.join(DATA_DIR, 'processed-orders.json');
const FAILED_FILE = path.join(DATA_DIR, 'failed-orders.json');
const INSTALLATIONS_FILE = path.join(DATA_DIR, 'shopify-installations.json');
const OAUTH_STATES_FILE = path.join(DATA_DIR, 'oauth-states.json');
const ADDRESS_ALIASES_FILE = path.join(DATA_DIR, 'address-aliases.json');
const FETCH_TIMEOUT_MS = numberEnv('FETCH_TIMEOUT_MS', 20000);
const MASTER_DATA_CACHE_TTL_MS = numberEnv('GHN_MASTER_DATA_CACHE_TTL_MS', 12 * 60 * 60 * 1000);

const ORDER_FULFILLMENT_QUERY = `
query OrderFulfillmentOrders($id: ID!) {
  order(id: $id) {
    id
    name
    displayFinancialStatus
    requiresShipping
    fulfillmentOrders(first: 10) {
      nodes {
        id
        status
        lineItems(first: 100) {
          nodes {
            id
            remainingQuantity
            totalQuantity
            requiresShipping
            productTitle
            sku
          }
        }
      }
    }
  }
}
`;

const FULFILLMENT_CREATE_MUTATION = `
mutation FulfillmentCreate($fulfillment: FulfillmentInput!, $message: String) {
  fulfillmentCreate(fulfillment: $fulfillment, message: $message) {
    fulfillment {
      id
      status
      trackingInfo(first: 5) {
        number
        url
        company
      }
    }
    userErrors {
      field
      message
    }
  }
}
`;

const TAGS_ADD_MUTATION = `
mutation TagsAdd($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) {
    node {
      id
    }
    userErrors {
      field
      message
    }
  }
}
`;

const TAGS_REMOVE_MUTATION = `
mutation TagsRemove($id: ID!, $tags: [String!]!) {
  tagsRemove(id: $id, tags: $tags) {
    node {
      id
    }
    userErrors {
      field
      message
    }
  }
}
`;

const config = {
  port: numberEnv('PORT', 3026),
  allowTestOrders: boolEnv('ALLOW_TEST_ORDERS', false),
  allowUnsignedTestWebhooks: boolEnv('ALLOW_UNSIGNED_TEST_WEBHOOKS', false),
  updateShopifyFulfillment: boolEnv('UPDATE_SHOPIFY_FULFILLMENT', true),
  notifyCustomer: boolEnv('SHOPIFY_NOTIFY_CUSTOMER', true),
  shopify: {
    shopDomain: env('SHOPIFY_SHOP_DOMAIN'),
    apiKey: env('SHOPIFY_API_KEY'),
    apiSecret: env('SHOPIFY_API_SECRET'),
    adminAccessToken: env('SHOPIFY_ADMIN_ACCESS_TOKEN'),
    webhookSecret: env('SHOPIFY_WEBHOOK_SECRET'),
    apiVersion: env('SHOPIFY_API_VERSION') || '2026-07',
    scopes: listEnv('SHOPIFY_SCOPES', [
      'read_orders',
      'write_orders',
      'read_merchant_managed_fulfillment_orders',
      'write_merchant_managed_fulfillment_orders'
    ]),
    publicAppUrl: env('PUBLIC_APP_URL')
  },
  ghn: {
    apiToken: env('GHN_API_TOKEN'),
    shopId: env('GHN_SHOP_ID'),
    clientId: env('GHN_CLIENT_ID'),
    baseUrl: env('GHN_BASE_URL') || 'https://online-gateway.ghn.vn',
    paymentTypeId: numberEnv('GHN_PAYMENT_TYPE_ID', 1),
    serviceTypeId: numberEnv('GHN_SERVICE_TYPE_ID', 2),
    requiredNote: env('GHN_REQUIRED_NOTE') || 'CHOXEMHANGKHONGTHU',
    trackingUrlTemplate: env('GHN_TRACKING_URL_TEMPLATE') || 'https://donhang.ghn.vn/?order_code={order_code}',
    webhookSecret: env('GHN_WEBHOOK_SECRET'),
    fromName: env('GHN_FROM_NAME'),
    fromPhone: env('GHN_FROM_PHONE'),
    fromAddress: env('GHN_FROM_ADDRESS'),
    fromWardName: env('GHN_FROM_WARD_NAME'),
    fromDistrictName: env('GHN_FROM_DISTRICT_NAME'),
    fromProvinceName: env('GHN_FROM_PROVINCE_NAME')
  },
  package: {
    itemWeightGrams: numberEnv('DEFAULT_ITEM_WEIGHT_GRAMS', 300),
    lengthCm: numberEnv('DEFAULT_PACKAGE_LENGTH_CM', 28),
    widthCm: numberEnv('DEFAULT_PACKAGE_WIDTH_CM', 22),
    heightCm: numberEnv('DEFAULT_PACKAGE_HEIGHT_CM', 4)
  },
  cod: {
    enabled: boolEnv('ENABLE_COD', true),
    gatewayKeywords: listEnv('COD_GATEWAY_KEYWORDS', [
      'cod',
      'cash on delivery',
      'thanh toán khi nhận hàng',
      'thanh toan khi nhan hang'
    ])
  },
  address: {
    aliasesJson: env('ADDRESS_ALIASES_JSON')
  },
  sync: {
    cancelGhnOnShopifyCancel: boolEnv('CANCEL_GHN_ON_SHOPIFY_CANCEL', true),
    updateShopifyTagsFromGhn: boolEnv('UPDATE_SHOPIFY_TAGS_FROM_GHN', true)
  }
};

const masterDataCache = new Map();

const BUILT_IN_ADDRESS_ALIASES = {
  provinces: [
    {
      aliases: ['tp hcm', 'tphcm', 'hcm', 'ho chi minh city', 'sai gon', 'saigon'],
      target: 'Ho Chi Minh'
    }
  ],
  districts: [
    {
      aliases: ['q binh thanh', 'quan binh thanh', 'binh thanh district'],
      target: 'Binh Thanh',
      whenAny: ['ho chi minh', 'hcm', 'sai gon', 'saigon']
    }
  ],
  wards: [
    {
      aliases: ['p22', 'p 22', 'phuong 22', 'ward 22'],
      target: 'Phuong 22',
      district: 'Binh Thanh',
      province: 'Ho Chi Minh',
      whenAny: ['ho chi minh', 'hcm', 'sai gon', 'saigon']
    }
  ]
};

const GHN_STATUS_LABELS = {
  ready_to_pick: 'San sang lay hang',
  picking: 'Dang lay hang',
  picked: 'Da lay hang',
  storing: 'Dang luu kho',
  transporting: 'Dang luan chuyen',
  sorting: 'Dang phan loai',
  delivering: 'Dang giao',
  delivered: 'Giao thanh cong',
  delivery_fail: 'Giao that bai',
  waiting_to_return: 'Cho hoan hang',
  return: 'Dang hoan hang',
  return_transporting: 'Dang chuyen hoan',
  return_sorting: 'Dang phan loai hoan',
  returning: 'Dang tra hang',
  return_fail: 'Tra hang that bai',
  returned: 'Da hoan hang',
  cancel: 'Da huy',
  exception: 'Can xu ly',
  damage: 'Hang hu hong',
  lost: 'That lac',
  money_collect_picking: 'Dang thu tien khi lay',
  money_collect_delivering: 'Dang thu tien khi giao'
};

const GHN_STATUS_TAG_PREFIX = 'GHN: ';
const GHN_STATUS_TAGS = Object.values(GHN_STATUS_LABELS).map((label) => `${GHN_STATUS_TAG_PREFIX}${label}`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}`);

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const installations = loadJson(INSTALLATIONS_FILE, {});
      return sendHtml(res, 200, statusPage(installations));
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, service: 'jforce-ghn-shopify-bridge' });
    }

    if (req.method === 'GET' && url.pathname === '/auth/shopify/start') {
      const redirectUrl = startShopifyOauth(url);
      res.writeHead(302, { Location: redirectUrl });
      return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/auth/shopify/callback') {
      const result = await finishShopifyOauth(url);
      return sendHtml(res, 200, successPage(result));
    }

    if (req.method === 'GET' && url.pathname === '/auth/status') {
      const installations = loadJson(INSTALLATIONS_FILE, {});
      return sendJson(res, 200, {
        ok: true,
        shops: Object.values(installations).map((installation) => ({
          shop: installation.shop,
          scopes: installation.scope,
          installedAt: installation.installedAt,
          webhooksRegisteredAt: installation.webhooksRegisteredAt,
          webhooksError: installation.webhooksError,
          webhooksErrorAt: installation.webhooksErrorAt
        }))
      });
    }

    if (req.method === 'POST' && url.pathname === '/webhooks/shopify/orders-paid') {
      const rawBody = await readRequestBody(req);
      verifyShopifyWebhook(rawBody, req.headers);
      const order = parseJson(rawBody);
      const shopDomain = req.headers['x-shopify-shop-domain'] || config.shopify.shopDomain;
      const result = await processOrderWebhook(order, 'orders_paid', shopDomain);
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/webhooks/shopify/orders-create') {
      const rawBody = await readRequestBody(req);
      verifyShopifyWebhook(rawBody, req.headers);
      const order = parseJson(rawBody);
      const shopDomain = req.headers['x-shopify-shop-domain'] || config.shopify.shopDomain;
      const result = await processOrderWebhook(order, 'orders_create', shopDomain);
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/webhooks/shopify/orders-cancelled') {
      const rawBody = await readRequestBody(req);
      verifyShopifyWebhook(rawBody, req.headers);
      const order = parseJson(rawBody);
      const shopDomain = req.headers['x-shopify-shop-domain'] || config.shopify.shopDomain;
      const result = await processOrderCancellationWebhook(order, shopDomain);
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/webhooks/ghn/order-status') {
      const rawBody = await readRequestBody(req);
      verifyGhnWebhook(url, req.headers);
      const body = parseJson(rawBody);
      const result = await processGhnStatusWebhook(body);
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/tools/resolve-address') {
      const rawBody = await readRequestBody(req);
      const body = parseJson(rawBody);
      const result = await resolveRecipientAddress(body.shipping_address || body);
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    const status = error.permanent ? 200 : 500;
    console.error(`${new Date().toISOString()} ${req.method} ${url.pathname} failed: ${error.message}`);
    recordFailure(req, error);
    return sendJson(res, status, {
      ok: false,
      error: error.message,
      permanent: Boolean(error.permanent)
    });
  }
});

server.listen(config.port, () => {
  console.log(`J FORCE GHN bridge is listening on port ${config.port}`);
  refreshRegisteredWebhooks().catch((error) => {
    console.error(`${new Date().toISOString()} refresh webhooks failed: ${error.message}`);
  });
});

async function refreshRegisteredWebhooks() {
  if (!config.shopify.publicAppUrl) return;

  const targets = [];
  if (config.shopify.shopDomain) {
    const shop = normalizeShopDomain(config.shopify.shopDomain);
    const accessToken = shopifyAccessToken(shop);
    if (accessToken) targets.push({ shop, accessToken });
  }

  const installations = loadJson(INSTALLATIONS_FILE, {});
  for (const installation of Object.values(installations)) {
    if (!installation.shop || !installation.accessToken) continue;
    const shop = normalizeShopDomain(installation.shop);
    if (targets.some((target) => target.shop === shop)) continue;
    targets.push({ shop, accessToken: installation.accessToken });
  }

  for (const target of targets) {
    await registerShopifyWebhooks(target.shop, target.accessToken);
    console.log(`${new Date().toISOString()} Shopify webhooks ready for ${target.shop}`);
  }
}

function startShopifyOauth(url) {
  validateShopifyOauthConfig();

  const shop = normalizeShopDomain(url.searchParams.get('shop') || config.shopify.shopDomain);
  const state = createOauthState(shop);
  const redirectUri = oauthRedirectUri();
  const installUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  installUrl.searchParams.set('client_id', config.shopify.apiKey);
  installUrl.searchParams.set('scope', config.shopify.scopes.join(','));
  installUrl.searchParams.set('redirect_uri', redirectUri);
  installUrl.searchParams.set('state', state);

  return installUrl.toString();
}

async function finishShopifyOauth(url) {
  validateShopifyOauthConfig();

  const shop = normalizeShopDomain(url.searchParams.get('shop'));
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code) {
    throw permanentError('Shopify khong tra ve ma cai dat app.');
  }

  verifyShopifyOauthHmac(url.searchParams);
  consumeOauthState(shop, state);

  const response = await fetchWithTimeout(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.shopify.apiKey,
      client_secret: config.shopify.apiSecret,
      code
    })
  }, 'Shopify OAuth access token');
  const json = await response.json().catch(() => ({}));

  if (!response.ok || !json.access_token) {
    throw new Error(`Shopify OAuth loi ${response.status}: ${JSON.stringify(json)}`);
  }

  const installations = loadJson(INSTALLATIONS_FILE, {});
  installations[shop] = {
    shop,
    accessToken: json.access_token,
    scope: json.scope,
    installedAt: new Date().toISOString()
  };
  writeJson(INSTALLATIONS_FILE, installations);

  let webhooksRegistered = false;
  let webhooksError = '';

  if (config.shopify.publicAppUrl) {
    try {
      await registerShopifyWebhooks(shop, json.access_token);
      webhooksRegistered = true;
      installations[shop].webhooksRegisteredAt = new Date().toISOString();
      delete installations[shop].webhooksError;
      delete installations[shop].webhooksErrorAt;
    } catch (error) {
      webhooksError = error.message;
      installations[shop].webhooksError = webhooksError;
      installations[shop].webhooksErrorAt = new Date().toISOString();
      console.error(`${new Date().toISOString()} webhook registration failed for ${shop}: ${webhooksError}`);
    }
    writeJson(INSTALLATIONS_FILE, installations);
  } else {
    webhooksError = 'Thieu PUBLIC_APP_URL nen chua dang ky webhook.';
  }

  return {
    shop,
    scope: json.scope,
    webhooksRegistered,
    webhooksError
  };
}

async function processOrderWebhook(order, topic, shopDomain) {
  validateRuntimeConfig();

  if (!order || typeof order !== 'object') {
    throw permanentError('Webhook khong co du lieu don hang hop le.');
  }

  const orderName = order.name || String(order.id || 'unknown');
  const orderKey = order.admin_graphql_api_id || (order.id ? `gid://shopify/Order/${order.id}` : orderName);
  const processed = loadJson(PROCESSED_FILE, {});

  if (processed[orderKey]?.shopifyFulfillmentId) {
    return {
      ok: true,
      skipped: true,
      reason: 'Don hang da co ma van don va da cap nhat Shopify.',
      order: orderName
    };
  }

  if (order.test && !config.allowTestOrders) {
    throw permanentError(`Bo qua don test ${orderName}.`);
  }

  const paymentPlan = resolvePaymentPlan(order);

  if (!order.shipping_address) {
    throw permanentError(`Don ${orderName} chua co dia chi giao hang.`);
  }

  const existing = processed[orderKey] || {};
  const ghnOrderCode = existing.ghnOrderCode || (await createGhnOrder(order, paymentPlan)).order_code;
  const trackingUrl = buildTrackingUrl(ghnOrderCode);

  processed[orderKey] = {
    ...existing,
    orderName,
    shopDomain: shopDomain || config.shopify.shopDomain,
    topic,
    paymentMode: paymentPlan.mode,
    codAmount: paymentPlan.codAmount,
    clientOrderCode: clientOrderCode(order),
    ghnOrderCode,
    trackingUrl,
    ghnCreatedAt: existing.ghnCreatedAt || new Date().toISOString()
  };
  writeJson(PROCESSED_FILE, processed);
  console.log(`${new Date().toISOString()} processed ${orderName} with GHN ${ghnOrderCode}`);

  if (!config.updateShopifyFulfillment) {
    return { ok: true, order: orderName, ghnOrderCode, trackingUrl, shopifyUpdated: false };
  }

  const fulfillment = await createShopifyFulfillment(orderKey, ghnOrderCode, trackingUrl, shopDomain);
  processed[orderKey] = {
    ...processed[orderKey],
    shopifyFulfillmentId: fulfillment.id,
    shopifyFulfillmentStatus: fulfillment.status,
    shopifyUpdatedAt: new Date().toISOString()
  };
  writeJson(PROCESSED_FILE, processed);
  console.log(`${new Date().toISOString()} updated Shopify fulfillment for ${orderName} with GHN ${ghnOrderCode}`);

  return {
    ok: true,
    order: orderName,
    ghnOrderCode,
    trackingUrl,
    shopifyFulfillmentId: fulfillment.id
  };
}

async function processOrderCancellationWebhook(order, shopDomain) {
  validateRuntimeConfig();

  if (!config.sync.cancelGhnOnShopifyCancel) {
    return {
      ok: true,
      skipped: true,
      reason: 'Dong bo huy van don GHN dang tat.'
    };
  }

  if (!order || typeof order !== 'object') {
    throw permanentError('Webhook huy don khong co du lieu don hang hop le.');
  }

  const info = shopifyOrderInfo(order);
  const processed = loadJson(PROCESSED_FILE, {});
  const found = findProcessedByShopifyOrder(processed, info);

  if (!found?.record?.ghnOrderCode) {
    return {
      ok: true,
      skipped: true,
      reason: 'Don Shopify chua co ma van don GHN de huy.',
      order: info.orderName
    };
  }

  if (found.record.ghnCancelledAt) {
    return {
      ok: true,
      skipped: true,
      reason: 'Van don GHN da duoc ghi nhan huy truoc do.',
      order: found.record.orderName || info.orderName,
      ghnOrderCode: found.record.ghnOrderCode
    };
  }

  const raw = await cancelGhnOrder(found.record.ghnOrderCode);
  const cancelledAt = new Date().toISOString();
  processed[found.orderKey] = {
    ...found.record,
    orderName: found.record.orderName || info.orderName,
    shopDomain: found.record.shopDomain || shopDomain || config.shopify.shopDomain,
    shopifyCancelledAt: info.cancelledAt || cancelledAt,
    shopifyCancelReason: info.cancelReason,
    ghnCancelledAt: cancelledAt,
    ghnCancelRaw: raw
  };
  writeJson(PROCESSED_FILE, processed);

  try {
    await addShopifyTags(found.orderKey, ['GHN', 'GHN: Da huy van don'], shopDomain || found.record.shopDomain);
  } catch (error) {
    console.error(`${new Date().toISOString()} khong them duoc tag huy GHN cho ${info.orderName}: ${error.message}`);
  }

  console.log(`${new Date().toISOString()} cancelled GHN ${found.record.ghnOrderCode} for ${info.orderName}`);
  return {
    ok: true,
    order: info.orderName,
    ghnOrderCode: found.record.ghnOrderCode,
    ghnCancelled: true
  };
}

async function processGhnStatusWebhook(body) {
  const event = normalizeGhnStatusEvent(body);
  const processed = loadJson(PROCESSED_FILE, {});
  const found = findProcessedByGhnOrder(processed, event);

  if (!found) {
    console.warn(`${new Date().toISOString()} GHN status webhook khong tim thay don Shopify cho ${event.orderCode || event.clientOrderCode}`);
    return {
      ok: true,
      skipped: true,
      reason: 'Khong tim thay don Shopify da luu cho ma GHN nay.',
      ghnOrderCode: event.orderCode,
      clientOrderCode: event.clientOrderCode,
      status: event.status
    };
  }

  const statusTag = ghnStatusTag(event.status);
  const updatedAt = new Date().toISOString();
  const record = {
    ...found.record,
    ghnStatus: event.status,
    ghnStatusLabel: event.statusLabel,
    ghnStatusUpdatedAt: updatedAt,
    lastGhnWebhook: event.raw
  };

  if (event.status === 'cancel') {
    record.ghnCancelledAt = record.ghnCancelledAt || updatedAt;
  }

  processed[found.orderKey] = record;
  writeJson(PROCESSED_FILE, processed);

  if (config.sync.updateShopifyTagsFromGhn && found.orderKey.startsWith('gid://shopify/Order/')) {
    await replaceShopifyGhnStatusTag(found.orderKey, statusTag, record.shopDomain || config.shopify.shopDomain);
  }

  console.log(`${new Date().toISOString()} GHN ${event.orderCode || event.clientOrderCode} status ${event.status} synced to ${record.orderName || found.orderKey}`);
  return {
    ok: true,
    order: record.orderName,
    ghnOrderCode: event.orderCode,
    status: event.status,
    tag: statusTag
  };
}

async function createGhnOrder(order, paymentPlan) {
  const shippingAddress = order.shipping_address;
  const recipientAddress = await resolveRecipientAddress(shippingAddress);
  const items = buildGhnItems(order);
  const quantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const calculatedWeight = items.reduce((sum, item) => sum + item.weight * item.quantity, 0);
  const totalWeight = Number(order.total_weight || order.current_total_weight || 0);
  const weight = Math.max(totalWeight, calculatedWeight, quantity * config.package.itemWeightGrams, config.package.itemWeightGrams);
  const insuranceValue = moneyToVnd(order.total_line_items_price || order.current_subtotal_price || order.subtotal_price || 0);

  const payload = {
    payment_type_id: config.ghn.paymentTypeId,
    note: `Shopify ${order.name || order.id || ''}`.trim(),
    required_note: config.ghn.requiredNote,
    from_name: config.ghn.fromName,
    from_phone: config.ghn.fromPhone,
    from_address: config.ghn.fromAddress,
    from_ward_name: config.ghn.fromWardName,
    from_district_name: config.ghn.fromDistrictName,
    from_province_name: config.ghn.fromProvinceName,
    to_name: shippingAddress.name || [shippingAddress.first_name, shippingAddress.last_name].filter(Boolean).join(' ') || 'Khach hang',
    to_phone: normalizePhone(shippingAddress.phone || order.phone || order.billing_address?.phone),
    to_address: joinAddress(shippingAddress),
    to_ward_code: recipientAddress.wardCode,
    to_district_id: recipientAddress.districtId,
    cod_amount: paymentPlan.codAmount,
    content: `J FORCE ${order.name || ''}`.trim(),
    weight,
    length: config.package.lengthCm,
    width: config.package.widthCm,
    height: config.package.heightCm,
    service_type_id: config.ghn.serviceTypeId,
    insurance_value: insuranceValue,
    client_order_code: clientOrderCode(order),
    items
  };

  if (!payload.to_phone) {
    throw permanentError(`Don ${order.name || order.id || ''} thieu so dien thoai nguoi nhan.`);
  }

  const response = await ghnRequest('/shiip/public-api/v2/shipping-order/create', {
    method: 'POST',
    body: payload,
    includeShopId: true
  });

  const orderCode = response?.data?.order_code;
  if (!orderCode) {
    throw new Error(`GHN da phan hoi nhung khong co ma van don: ${JSON.stringify(response)}`);
  }

  return { order_code: orderCode, raw: response };
}

async function cancelGhnOrder(orderCode) {
  if (!orderCode) {
    throw permanentError('Khong co ma van don GHN de huy.');
  }

  return ghnRequest('/shiip/public-api/v2/switch-status/cancel', {
    method: 'POST',
    includeShopId: true,
    body: {
      order_codes: [orderCode]
    }
  });
}

function resolvePaymentPlan(order) {
  const financialStatus = String(order.financial_status || '').toLowerCase();

  if (!financialStatus || financialStatus === 'paid' || financialStatus === 'partially_paid') {
    return {
      mode: 'prepaid',
      codAmount: 0
    };
  }

  if (config.cod.enabled && isCodOrder(order)) {
    return {
      mode: 'cod',
      codAmount: calculateCodAmount(order)
    };
  }

  throw permanentError(`Bo qua don ${order.name || order.id || ''} vi chua thanh toan va khong phai COD.`);
}

function isCodOrder(order) {
  const gatewayNames = Array.isArray(order.payment_gateway_names)
    ? order.payment_gateway_names
    : [order.gateway, order.payment_gateway_name].filter(Boolean);

  const normalizedGateways = gatewayNames.map(normalizeText);
  return config.cod.gatewayKeywords.some((keyword) => {
    const normalizedKeyword = normalizeText(keyword);
    return normalizedGateways.some((gateway) => gateway.includes(normalizedKeyword));
  });
}

function calculateCodAmount(order) {
  const outstanding = moneyToVnd(order.total_outstanding);
  if (outstanding > 0) return outstanding;

  return moneyToVnd(
    order.current_total_price ||
    order.total_price ||
    order.total_line_items_price ||
    0
  );
}

async function getGhnProvinces() {
  return cachedGhnMasterData('province', '/shiip/public-api/master-data/province', { method: 'GET' });
}

async function getGhnDistricts(provinceId) {
  return cachedGhnMasterData(`district:${provinceId}`, '/shiip/public-api/master-data/district', {
    method: 'GET',
    query: { province_id: provinceId }
  });
}

async function getGhnWards(districtId) {
  return cachedGhnMasterData(`ward:${districtId}`, '/shiip/public-api/master-data/ward', {
    method: 'GET',
    query: { district_id: districtId }
  });
}

async function cachedGhnMasterData(cacheKey, apiPath, options) {
  const cached = masterDataCache.get(cacheKey);
  if (cached && Date.now() - cached.at < MASTER_DATA_CACHE_TTL_MS) {
    return cached.value;
  }

  const value = await ghnRequest(apiPath, options);
  masterDataCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

async function resolveRecipientAddress(shippingAddress) {
  const country = shippingAddress.country_code || shippingAddress.countryCode || shippingAddress.country;
  if (country && !['VN', 'VIETNAM', 'VIET NAM', 'VIET NAM'].includes(normalizeText(country).toUpperCase())) {
    throw permanentError('GHN chi ho tro don giao trong Viet Nam.');
  }

  const candidates = expandAddressCandidates(addressCandidates(shippingAddress));
  const provinces = await getGhnProvinces();
  const province = findBestMatch(provinces.data || [], 'ProvinceName', candidates, 'province');
  if (!province) {
    const inferred = await findAddressAcrossProvinces(provinces.data || [], candidates);
    if (inferred) return formatResolvedAddress(inferred.province, inferred.district, inferred.ward);
    throw permanentError(`Khong tim duoc tinh/thanh GHN tu dia chi: ${candidates.join(' | ')}`);
  }

  const districts = await getGhnDistricts(province.ProvinceID);
  const district = findBestMatch(districts.data || [], 'DistrictName', candidates, 'district');
  if (district) {
    const resolved = await resolveWardForDistrict(district, candidates);
    if (resolved) {
      return formatResolvedAddress(province, resolved.district, resolved.ward);
    }
  }

  const inferred = await findWardAcrossDistricts(districts.data || [], candidates);
  if (inferred) {
    return formatResolvedAddress(province, inferred.district, inferred.ward);
  }

  const inferredProvince = await findAddressAcrossProvinces(provinces.data || [], candidates, province.ProvinceID);
  if (!inferredProvince) {
    throw permanentError(`Khong tim duoc quan/phuong GHN tu dia chi, hay them quan/huyen vao dia chi: ${candidates.join(' | ')}`);
  }

  return formatResolvedAddress(inferredProvince.province, inferredProvince.district, inferredProvince.ward);
}

function formatResolvedAddress(province, district, ward) {
  return {
    provinceId: province.ProvinceID,
    provinceName: province.ProvinceName,
    districtId: district.DistrictID,
    districtName: district.DistrictName,
    wardCode: String(ward.WardCode),
    wardName: ward.WardName
  };
}

async function resolveWardForDistrict(district, candidates) {
  const wards = await getGhnWards(district.DistrictID);
  const ward = findBestMatch(wards.data || [], 'WardName', candidates, 'ward');
  return ward ? { district, ward } : null;
}

async function findWardAcrossDistricts(districts, candidates) {
  const matches = [];

  for (const district of districts) {
    const wards = await getGhnWards(district.DistrictID);
    const match = findBestMatchWithScore(wards.data || [], 'WardName', candidates, 'ward');
    if (match.best && match.bestScore >= 80) {
      matches.push({ district, ward: match.best, score: match.bestScore });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1 && matches[0].score > matches[1].score) return matches[0];
  return null;
}

async function findAddressAcrossProvinces(provinces, candidates, excludedProvinceId) {
  const matches = [];

  for (const province of provinces) {
    if (excludedProvinceId && Number(province.ProvinceID) === Number(excludedProvinceId)) {
      continue;
    }

    const districts = await getGhnDistricts(province.ProvinceID);
    const districtMatch = findBestMatchWithScore(districts.data || [], 'DistrictName', candidates, 'district');
    if (districtMatch.best) {
      const resolved = await resolveWardForDistrict(districtMatch.best, candidates);
      if (resolved) {
        matches.push({
          province,
          district: resolved.district,
          ward: resolved.ward,
          score: districtMatch.bestScore + 20
        });
        continue;
      }
    }

    const inferred = await findWardAcrossDistricts(districts.data || [], candidates);
    if (inferred) {
      matches.push({
        province,
        district: inferred.district,
        ward: inferred.ward,
        score: inferred.score
      });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1 && matches[0].score > matches[1].score) return matches[0];
  return null;
}

async function createShopifyFulfillment(orderGid, ghnOrderCode, trackingUrl, shopDomain) {
  const normalizedShop = normalizeShopDomain(shopDomain || config.shopify.shopDomain);
  const accessToken = shopifyAccessToken(normalizedShop);
  if (!accessToken) {
    throw new Error(`Chua co Shopify access token cho shop ${normalizedShop}.`);
  }

  const orderResponse = await shopifyGraphql(
    ORDER_FULFILLMENT_QUERY,
    { id: orderGid },
    normalizedShop,
    accessToken
  );
  const order = orderResponse.data?.order;
  if (!order) {
    throw new Error(`Khong tim thay don Shopify ${orderGid}.`);
  }

  if (!order.requiresShipping) {
    throw permanentError(`Don ${order.name} khong can giao hang.`);
  }

  const lineItemsByFulfillmentOrder = [];
  for (const fulfillmentOrder of order.fulfillmentOrders.nodes || []) {
    if (!['OPEN', 'IN_PROGRESS'].includes(fulfillmentOrder.status)) {
      continue;
    }

    const fulfillmentOrderLineItems = (fulfillmentOrder.lineItems.nodes || [])
      .filter((item) => item.requiresShipping && item.remainingQuantity > 0)
      .map((item) => ({ id: item.id, quantity: item.remainingQuantity }));

    if (fulfillmentOrderLineItems.length > 0) {
      lineItemsByFulfillmentOrder.push({
        fulfillmentOrderId: fulfillmentOrder.id,
        fulfillmentOrderLineItems
      });
    }
  }

  if (lineItemsByFulfillmentOrder.length === 0) {
    throw permanentError(`Don ${order.name} khong con san pham nao de cap nhat van don.`);
  }

  const variables = {
    fulfillment: {
      notifyCustomer: config.notifyCustomer,
      trackingInfo: {
        company: 'GHN',
        number: ghnOrderCode,
        url: trackingUrl
      },
      lineItemsByFulfillmentOrder
    },
    message: `GHN ${ghnOrderCode}`
  };

  const response = await shopifyGraphql(FULFILLMENT_CREATE_MUTATION, variables, normalizedShop, accessToken);
  const userErrors = response.data?.fulfillmentCreate?.userErrors || [];
  if (userErrors.length) {
    throw new Error(`Shopify khong cap nhat duoc tracking: ${userErrors.map((error) => error.message).join('; ')}`);
  }

  return response.data.fulfillmentCreate.fulfillment;
}

async function replaceShopifyGhnStatusTag(orderGid, statusTag, shopDomain) {
  await removeShopifyTags(orderGid, GHN_STATUS_TAGS, shopDomain);
  return addShopifyTags(orderGid, ['GHN', statusTag], shopDomain);
}

async function addShopifyTags(orderGid, tags, shopDomain) {
  return mutateShopifyTags(TAGS_ADD_MUTATION, 'tagsAdd', orderGid, tags, shopDomain);
}

async function removeShopifyTags(orderGid, tags, shopDomain) {
  return mutateShopifyTags(TAGS_REMOVE_MUTATION, 'tagsRemove', orderGid, tags, shopDomain);
}

async function mutateShopifyTags(mutation, fieldName, orderGid, tags, shopDomain) {
  const normalizedShop = normalizeShopDomain(shopDomain || config.shopify.shopDomain);
  const accessToken = shopifyAccessToken(normalizedShop);
  if (!accessToken) {
    throw new Error(`Chua co Shopify access token cho shop ${normalizedShop}.`);
  }

  const uniqueTags = uniqueStrings(tags).filter(Boolean);
  if (!uniqueTags.length) {
    return null;
  }

  const response = await shopifyGraphql(
    mutation,
    { id: orderGid, tags: uniqueTags },
    normalizedShop,
    accessToken
  );

  const userErrors = response.data?.[fieldName]?.userErrors || [];
  if (userErrors.length) {
    throw new Error(`Shopify khong cap nhat duoc tag: ${userErrors.map((error) => error.message).join('; ')}`);
  }

  return response.data?.[fieldName]?.node || null;
}

async function registerShopifyWebhooks(shopDomain, accessToken) {
  const baseUrl = config.shopify.publicAppUrl.replace(/\/+$/, '');
  const targets = [
    { topic: 'ORDERS_PAID', uri: `${baseUrl}/webhooks/shopify/orders-paid` },
    { topic: 'ORDERS_CANCELLED', uri: `${baseUrl}/webhooks/shopify/orders-cancelled` }
  ];

  if (config.cod.enabled) {
    targets.push({ topic: 'ORDERS_CREATE', uri: `${baseUrl}/webhooks/shopify/orders-create` });
  }

  const existing = await shopifyGraphql(
    `query ExistingWebhooks($first: Int!) {
      webhookSubscriptions(first: $first) {
        nodes {
          id
          topic
          uri
        }
      }
    }`,
    { first: 100 },
    shopDomain,
    accessToken
  );
  const existingWebhooks = existing.data.webhookSubscriptions.nodes || [];

  for (const target of targets) {
    const alreadyExists = existingWebhooks.some((webhook) => webhook.topic === target.topic && webhook.uri === target.uri);
    if (alreadyExists) continue;

    const created = await shopifyGraphql(
      `mutation WebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
          webhookSubscription {
            id
            topic
            uri
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        topic: target.topic,
        webhookSubscription: {
          format: 'JSON',
          uri: target.uri
        }
      },
      shopDomain,
      accessToken
    );
    const userErrors = created.data.webhookSubscriptionCreate.userErrors || [];
    if (userErrors.length) {
      throw new Error(`Khong dang ky duoc webhook ${target.topic}: ${userErrors.map((error) => error.message).join('; ')}`);
    }
  }
}

async function shopifyGraphql(query, variables, shopDomain, accessToken) {
  const url = `https://${shopDomain}/admin/api/${config.shopify.apiVersion}/graphql.json`;
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken
    },
    body: JSON.stringify({ query, variables })
  }, 'Shopify Admin GraphQL');
  const json = await response.json().catch(() => ({}));

  if (!response.ok || json.errors) {
    throw new Error(`Shopify API loi ${response.status}: ${JSON.stringify(json.errors || json)}`);
  }

  return json;
}

async function ghnRequest(apiPath, options = {}) {
  const url = new URL(apiPath, config.ghn.baseUrl);
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = {
    Token: config.ghn.apiToken,
    'Content-Type': 'application/json'
  };

  if (options.includeShopId) {
    headers.ShopId = String(config.ghn.shopId);
  }

  const response = await fetchWithTimeout(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  }, 'GHN API');
  const json = await response.json().catch(() => ({}));

  if (!response.ok || (json.code && Number(json.code) !== 200)) {
    throw new Error(`GHN API loi ${response.status}: ${JSON.stringify(json)}`);
  }

  return json;
}

async function fetchWithTimeout(url, options = {}, label = 'Request') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`${label} qua lau sau ${FETCH_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function validateRuntimeConfig() {
  const required = [
    ['GHN_API_TOKEN', config.ghn.apiToken],
    ['GHN_SHOP_ID', config.ghn.shopId],
    ['GHN_FROM_NAME', config.ghn.fromName],
    ['GHN_FROM_PHONE', config.ghn.fromPhone],
    ['GHN_FROM_ADDRESS', config.ghn.fromAddress],
    ['GHN_FROM_WARD_NAME', config.ghn.fromWardName],
    ['GHN_FROM_DISTRICT_NAME', config.ghn.fromDistrictName],
    ['GHN_FROM_PROVINCE_NAME', config.ghn.fromProvinceName]
  ];

  if (config.updateShopifyFulfillment) {
    required.push(['SHOPIFY_SHOP_DOMAIN or webhook shop domain', config.shopify.shopDomain]);
  }

  if (!config.allowUnsignedTestWebhooks) {
    required.push(['SHOPIFY_WEBHOOK_SECRET or SHOPIFY_API_SECRET', webhookSecret()]);
  }

  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new Error(`Thieu cau hinh: ${missing.join(', ')}`);
  }
}

function validateShopifyOauthConfig() {
  const required = [
    ['SHOPIFY_API_KEY', config.shopify.apiKey],
    ['SHOPIFY_API_SECRET', config.shopify.apiSecret],
    ['PUBLIC_APP_URL', config.shopify.publicAppUrl]
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new Error(`Thieu cau hinh OAuth Shopify: ${missing.join(', ')}`);
  }
}

function buildGhnItems(order) {
  const sourceItems = Array.isArray(order.line_items) ? order.line_items : [];
  const items = sourceItems
    .filter((item) => item.requires_shipping !== false)
    .map((item) => ({
      name: String(item.title || item.name || 'J FORCE Jersey').slice(0, 255),
      code: String(item.sku || item.variant_id || item.id || '').slice(0, 50),
      quantity: Math.max(1, Number(item.quantity || 1)),
      price: moneyToVnd(item.price || 0),
      weight: Math.max(config.package.itemWeightGrams, Number(item.grams || 0) || config.package.itemWeightGrams)
    }));

  if (!items.length) {
    items.push({
      name: 'J FORCE Jersey',
      code: clientOrderCode(order),
      quantity: 1,
      price: moneyToVnd(order.total_line_items_price || 0),
      weight: config.package.itemWeightGrams
    });
  }

  return items;
}

function findBestMatch(list, field, candidates, level) {
  const match = findBestMatchWithScore(list, field, candidates, level);
  return match.bestScore >= 40 ? match.best : null;
}

function findBestMatchWithScore(list, field, candidates, level) {
  let best = null;
  let bestScore = 0;

  for (const item of list) {
    const name = item[field];
    for (const candidate of candidates) {
      const score = matchScore(name, candidate, level);
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    }
  }

  return { best, bestScore };
}

function matchScore(targetName, candidate, level) {
  const targetFull = normalizeText(targetName);
  const targetSimple = stripAdminWords(targetName);
  const candidateFull = normalizeText(candidate);
  const candidateSimple = stripAdminWords(candidate);

  if (!targetFull || !candidateFull) return 0;
  if (candidateFull === targetFull) return 100;
  if (candidateFull.includes(targetFull)) return 90;

  if (level === 'district' && /^\d+$/.test(targetSimple)) {
    const signals = [
      `quan ${targetSimple}`,
      `q ${targetSimple}`,
      `district ${targetSimple}`
    ];
    return signals.some((signal) => candidateFull.includes(signal)) ? 85 : 0;
  }

  if (level === 'ward' && /^\d+$/.test(targetSimple)) {
    const signals = [
      `phuong ${targetSimple}`,
      `p ${targetSimple}`,
      `ward ${targetSimple}`,
      `xa ${targetSimple}`
    ];
    return signals.some((signal) => candidateFull.includes(signal)) ? 85 : 0;
  }

  if (targetSimple && candidateSimple === targetSimple) return 80;
  if (targetSimple && targetSimple.length >= 3 && candidateSimple.includes(targetSimple)) return 70;
  if (targetSimple && targetSimple.length >= 3 && candidateFull.includes(targetSimple)) return 60;

  return 0;
}

function stripAdminWords(value) {
  return normalizeText(value)
    .replace(/\b(thanh pho|tp|tinh|quan|huyen|thi xa|thi tran|phuong|xa|ward|district|city|province)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function addressCandidates(address) {
  const formatted = Array.isArray(address.formatted) ? address.formatted.join(', ') : '';
  const raw = [
    address.address1,
    address.address2,
    address.city,
    address.province,
    address.province_code,
    address.zip,
    formatted,
    joinAddress(address)
  ].filter(Boolean);

  const split = raw.flatMap(splitAddressCandidate);
  return uniqueStrings([...raw, ...split]);
}

function splitAddressCandidate(value) {
  return String(value || '')
    .split(/[,;\n|]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function expandAddressCandidates(candidates) {
  const expanded = new Set(candidates.filter(Boolean));
  const normalizedCandidates = candidates.map(normalizeText).filter(Boolean);

  for (const rule of addressAliasRules()) {
    if (!addressAliasRuleMatches(rule, normalizedCandidates)) continue;

    for (const value of [rule.target, rule.province, rule.district, rule.ward]) {
      if (value) expanded.add(value);
    }

    if (rule.ward && rule.district) expanded.add(`${rule.ward}, ${rule.district}`);
    if (rule.district && rule.province) expanded.add(`${rule.district}, ${rule.province}`);
    if (rule.ward && rule.district && rule.province) {
      expanded.add(`${rule.ward}, ${rule.district}, ${rule.province}`);
    }
  }

  return uniqueStrings([...expanded]);
}

function addressAliasRules() {
  const configs = [BUILT_IN_ADDRESS_ALIASES, loadAddressAliasesFromEnv(), loadJson(ADDRESS_ALIASES_FILE, {})];
  return configs.flatMap(normalizeAddressAliasConfig);
}

function loadAddressAliasesFromEnv() {
  if (!config.address.aliasesJson) return {};
  try {
    return JSON.parse(config.address.aliasesJson);
  } catch (error) {
    console.error(`${new Date().toISOString()} ADDRESS_ALIASES_JSON invalid: ${error.message}`);
    return {};
  }
}

function normalizeAddressAliasConfig(configValue) {
  if (!configValue) return [];
  if (Array.isArray(configValue)) return configValue.map(normalizeAddressAliasRule).filter(Boolean);

  return [
    ...aliasGroup(configValue.provinces, 'province'),
    ...aliasGroup(configValue.districts, 'district'),
    ...aliasGroup(configValue.wards, 'ward')
  ];
}

function aliasGroup(rules, level) {
  if (!Array.isArray(rules)) return [];
  return rules.map((rule) => normalizeAddressAliasRule({ ...rule, level })).filter(Boolean);
}

function normalizeAddressAliasRule(rule) {
  const aliases = [rule.alias, ...(rule.aliases || []), ...(rule.from || [])]
    .filter(Boolean)
    .map(normalizeText)
    .filter(Boolean);
  const target = rule.target || rule.to || rule.name || rule.ward || rule.district || rule.province;

  if (!aliases.length || !target) return null;

  const normalized = {
    aliases,
    target,
    level: rule.level || 'ward',
    province: rule.province || '',
    district: rule.district || '',
    ward: rule.ward || '',
    whenAny: normalizeStringList(rule.whenAny),
    whenAll: normalizeStringList(rule.whenAll)
  };

  if (normalized.level === 'province') normalized.province = normalized.target;
  if (normalized.level === 'district') normalized.district = normalized.target;
  if (normalized.level === 'ward') normalized.ward = normalized.target;
  return normalized;
}

function addressAliasRuleMatches(rule, normalizedCandidates) {
  const haystack = normalizedCandidates.join(' | ');
  if (!rule.aliases.some((alias) => haystack.includes(alias))) return false;
  if (rule.whenAny.length && !rule.whenAny.some((item) => haystack.includes(item))) return false;
  if (rule.whenAll.length && !rule.whenAll.every((item) => haystack.includes(item))) return false;
  return true;
}

function normalizeStringList(value) {
  if (!value) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map(normalizeText).filter(Boolean);
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value || '').trim();
    const key = normalizeText(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function joinAddress(address) {
  return [
    address.address1,
    address.address2,
    address.city,
    address.province,
    address.zip
  ].filter(Boolean).join(', ');
}

function clientOrderCode(order) {
  const raw = order.name || order.order_number || order.id || Date.now();
  const code = String(raw).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50);
  return code || `order-${Date.now()}`;
}

function shopifyOrderInfo(order) {
  const orderName = order.name || String(order.order_number || order.id || 'unknown');
  const orderGid = order.admin_graphql_api_id || (order.id ? `gid://shopify/Order/${order.id}` : '');
  return {
    orderGid,
    orderName,
    orderId: order.id ? String(order.id) : '',
    clientOrderCode: clientOrderCode(order),
    cancelledAt: order.cancelled_at || order.cancelledAt || '',
    cancelReason: order.cancel_reason || order.cancelReason || ''
  };
}

function findProcessedByShopifyOrder(processed, info) {
  if (info.orderGid && processed[info.orderGid]) {
    return { orderKey: info.orderGid, record: processed[info.orderGid] };
  }

  const candidates = [
    info.orderName,
    info.orderId,
    info.clientOrderCode
  ].map(normalizeExternalCode).filter(Boolean);

  for (const [orderKey, record] of Object.entries(processed)) {
    const recordCandidates = [
      orderKey,
      record.orderName,
      record.clientOrderCode,
      record.shopifyOrderId
    ].map(normalizeExternalCode).filter(Boolean);

    if (recordCandidates.some((value) => candidates.includes(value))) {
      return { orderKey, record };
    }
  }

  return null;
}

function findProcessedByGhnOrder(processed, event) {
  const orderCode = normalizeExternalCode(event.orderCode);
  const clientOrderCode = normalizeExternalCode(event.clientOrderCode);

  for (const [orderKey, record] of Object.entries(processed)) {
    if (orderCode && normalizeExternalCode(record.ghnOrderCode) === orderCode) {
      return { orderKey, record };
    }

    if (clientOrderCode && normalizeExternalCode(record.clientOrderCode) === clientOrderCode) {
      return { orderKey, record };
    }
  }

  return null;
}

function normalizeGhnStatusEvent(body) {
  const data = body && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {};
  const orderCode = firstString(
    body?.order_code,
    body?.orderCode,
    body?.OrderCode,
    data.order_code,
    data.orderCode,
    data.OrderCode
  );
  const clientOrderCode = firstString(
    body?.client_order_code,
    body?.clientOrderCode,
    body?.ClientOrderCode,
    data.client_order_code,
    data.clientOrderCode,
    data.ClientOrderCode
  );
  const status = normalizeGhnStatus(firstString(
    body?.status,
    body?.Status,
    body?.order_status,
    body?.OrderStatus,
    data.status,
    data.Status,
    data.order_status,
    data.OrderStatus
  ));

  if (!orderCode && !clientOrderCode) {
    throw permanentError('Webhook GHN thieu ma van don hoac ma don doi tac.');
  }

  if (!status) {
    throw permanentError('Webhook GHN thieu trang thai don hang.');
  }

  return {
    orderCode,
    clientOrderCode,
    status,
    statusLabel: ghnStatusLabel(status),
    reason: firstString(body?.reason, body?.Reason, data.reason, data.Reason),
    raw: body
  };
}

function firstString(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function normalizeGhnStatus(value) {
  return normalizeText(value).replace(/\s+/g, '_');
}

function ghnStatusTag(status) {
  return `${GHN_STATUS_TAG_PREFIX}${ghnStatusLabel(status)}`;
}

function ghnStatusLabel(status) {
  return GHN_STATUS_LABELS[status] || humanizeStatus(status);
}

function humanizeStatus(status) {
  return String(status || '')
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Cap nhat trang thai';
}

function normalizeExternalCode(value) {
  return String(value || '').trim().toLowerCase();
}

function moneyToVnd(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function normalizePhone(value) {
  return String(value || '').replace(/[^\d+]/g, '');
}

function buildTrackingUrl(orderCode) {
  return config.ghn.trackingUrlTemplate.replace('{order_code}', encodeURIComponent(orderCode));
}

function verifyShopifyWebhook(rawBody, headers) {
  if (config.allowUnsignedTestWebhooks) {
    return;
  }

  const secret = webhookSecret();
  const hmac = headers['x-shopify-hmac-sha256'];
  if (!secret || !hmac) {
    throw new Error('Thieu Shopify webhook secret hoac chu ky webhook.');
  }

  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const left = Buffer.from(digest);
  const right = Buffer.from(String(hmac));

  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw new Error('Chu ky webhook Shopify khong hop le.');
  }
}

function verifyGhnWebhook(url, headers) {
  const secret = config.ghn.webhookSecret;
  if (!secret) return;

  const authHeader = String(headers.authorization || '');
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const provided = firstString(
    url.searchParams.get('secret'),
    headers['x-ghn-webhook-secret'],
    bearer
  );

  if (!provided || !safeEqual(provided, secret)) {
    throw new Error('Chu ky webhook GHN khong hop le.');
  }
}

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue));
  const right = Buffer.from(String(rightValue));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyShopifyOauthHmac(searchParams) {
  const hmac = searchParams.get('hmac');
  if (!hmac) {
    throw permanentError('Thieu chu ky Shopify OAuth.');
  }

  const pairs = [];
  for (const [key, value] of searchParams.entries()) {
    if (key === 'hmac' || key === 'signature') continue;
    pairs.push([key, value]);
  }
  pairs.sort(([left], [right]) => left.localeCompare(right));
  const message = pairs.map(([key, value]) => `${key}=${value}`).join('&');
  const digest = crypto.createHmac('sha256', config.shopify.apiSecret).update(message).digest('hex');

  const left = Buffer.from(digest, 'utf8');
  const right = Buffer.from(hmac, 'utf8');
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw permanentError('Chu ky Shopify OAuth khong hop le.');
  }
}

function createOauthState(shop) {
  const states = loadJson(OAUTH_STATES_FILE, {});
  const state = crypto.randomBytes(24).toString('base64url');
  states[state] = {
    shop,
    createdAt: Date.now()
  };
  writeJson(OAUTH_STATES_FILE, states);
  return state;
}

function consumeOauthState(shop, state) {
  const states = loadJson(OAUTH_STATES_FILE, {});
  const record = states[state];
  delete states[state];
  writeJson(OAUTH_STATES_FILE, states);

  if (!record || record.shop !== shop || Date.now() - record.createdAt > 10 * 60 * 1000) {
    throw permanentError('Phien cai dat Shopify da het han, hay mo lai link cai dat.');
  }
}

function oauthRedirectUri() {
  return `${config.shopify.publicAppUrl.replace(/\/+$/, '')}/auth/shopify/callback`;
}

function normalizeShopDomain(value) {
  const shop = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    throw permanentError(`Shopify shop domain khong hop le: ${shop || '(trong)'}`);
  }
  return shop;
}

function shopifyAccessToken(shopDomain) {
  if (config.shopify.adminAccessToken) {
    return config.shopify.adminAccessToken;
  }

  const installations = loadJson(INSTALLATIONS_FILE, {});
  return installations[shopDomain]?.accessToken || '';
}

function webhookSecret() {
  return config.shopify.webhookSecret || config.shopify.apiSecret;
}

function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw permanentError('Body khong phai JSON hop le.');
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function statusPage(installations) {
  const shops = Object.values(installations);
  const rows = shops.length ? shops.map((installation) => `
        <tr>
          <td>${escapeHtml(installation.shop)}</td>
          <td>${escapeHtml(installation.installedAt || '')}</td>
          <td>${escapeHtml(installation.webhooksRegisteredAt || 'Chua co')}</td>
          <td>${escapeHtml(installation.webhooksError || '')}</td>
        </tr>`).join('') : `
        <tr><td colspan="4">Chua co shop nao cai app.</td></tr>`;

  return `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8">
    <title>J FORCE GHN Bridge</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 48px; color: #202223; line-height: 1.5; }
      main { max-width: 860px; }
      code { background: #f1f2f4; padding: 2px 6px; border-radius: 4px; }
      table { border-collapse: collapse; width: 100%; margin-top: 20px; }
      th, td { border: 1px solid #dfe3e8; padding: 10px; text-align: left; vertical-align: top; }
      th { background: #f6f6f7; }
    </style>
  </head>
  <body>
    <main>
      <h1>J FORCE GHN Bridge</h1>
      <p>Service dang hoat dong. Health check: <code>/health</code></p>
      <table>
        <thead>
          <tr>
            <th>Shop</th>
            <th>Da cai luc</th>
            <th>Webhook da dang ky luc</th>
            <th>Loi webhook gan nhat</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </main>
  </body>
</html>`;
}

function successPage(result) {
  return `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8">
    <title>J FORCE GHN Bridge</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 48px; color: #202223; line-height: 1.5; }
      main { max-width: 680px; }
      code { background: #f1f2f4; padding: 2px 6px; border-radius: 4px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Da ket noi Shopify voi GHN</h1>
      <p>Shop <code>${escapeHtml(result.shop)}</code> da cap quyen cho cau noi.</p>
      <p>Webhook: ${result.webhooksRegistered ? 'da dang ky' : 'chua dang ky'}.</p>
      ${result.webhooksError ? `<p>Luu y: ${escapeHtml(result.webhooksError)}</p>` : ''}
      <p>Ban co the quay lai Codex de tiep tuc test don hang.</p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const equalsAt = trimmed.indexOf('=');
    if (equalsAt === -1) continue;

    const key = trimmed.slice(0, equalsAt).trim();
    let value = trimmed.slice(equalsAt + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function env(name) {
  return process.env[name] || '';
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function listEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function recordFailure(req, error) {
  const failures = loadJson(FAILED_FILE, []);
  failures.push({
    at: new Date().toISOString(),
    method: req.method,
    url: req.url,
    permanent: Boolean(error.permanent),
    message: error.message
  });
  writeJson(FAILED_FILE, failures.slice(-100));
  console.error(error);
}

function permanentError(message) {
  const error = new Error(message);
  error.permanent = true;
  return error;
}
