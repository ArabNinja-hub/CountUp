import { Language } from '../types';

export interface Translations {
  appName: string;
  tagline: string;
  // Tabs
  tabSell: string;
  tabStock: string;
  tabCredit: string;
  tabReports: string;
  // Sell
  quickSale: string;
  searchItem: string;
  pickItems: string;
  qty: string;
  total: string;
  paidNow: string;
  paidCash: string;
  paidMomo: string;
  onCredit: string;
  selectCustomer: string;
  newCustomer: string;
  customerName: string;
  customerPhone: string;
  completeSale: string;
  saleRecorded: string;
  saleRecordedSubtitle: string;
  nextCustomer: string;
  cartEmpty: string;
  cartEmptyHint: string;
  clearCart: string;
  recentItems: string;
  allItems: string;
  pricePerUnit: string;
  stockLeft: string;
  outOfStock: string;
  // Stock
  stockTitle: string;
  addItem: string;
  editItem: string;
  deleteItem: string;
  itemName: string;
  buyingPrice: string;
  sellingPrice: string;
  inStock: string;
  lowStockAlert: string;
  lowStockTab: string;
  allStockTab: string;
  quickAddStock: string;
  restocked: string;
  lowStockWarning: string;
  saveItem: string;
  noItemsYet: string;
  noItemsYetHint: string;
  // Credit
  creditTitle: string;
  totalCreditOwed: string;
  customersWithDebt: string;
  recordPayment: string;
  sendReminder: string;
  reminderMessage: string;
  whatsappReminder: string;
  paymentAmount: string;
  paymentSaved: string;
  paymentHistory: string;
  debtCleared: string;
  noCreditCustomers: string;
  noCreditHint: string;
  customerHistory: string;
  creditPurchases: string;
  // Reports
  reportsTitle: string;
  dailyView: string;
  weeklyView: string;
  monthlyView: string;
  totalSales: string;
  totalProfit: string;
  cashReceived: string;
  momoReceived: string;
  moneyOwed: string;
  topSelling: string;
  noSalesPeriod: string;
  expenses: string;
  addExpense: string;
  expenseCategory: string;
  expenseAmount: string;
  expenseNote: string;
  expenseSaved: string;
  categories: {
    rent: string;
    transport: string;
    restock: string;
    council_fee: string;
    helper_wage: string;
    other: string;
  };
  exportSummary: string;
  copiedToClipboard: string;
  // Subscription
  planTitle: string;
  trialBadge: string;
  daysRemaining: string;
  planExpired: string;
  planExpiredNotice: string;
  gracePeriodNotice: string;
  warningNotice: string;
  payNow: string;
  selectPlan: string;
  mobileMoneyPayment: string;
  enterMomoNumber: string;
  momoPromptInfo: string;
  testPaymentSuccess: string;
  existingDataSafe: string;
  // Auth
  loginTitle: string;
  loginSubtitle: string;
  phoneNumber: string;
  pin: string;
  shopName: string;
  logInBtn: string;
  registerBtn: string;
  switchRegister: string;
  switchLogin: string;
  logout: string;
  // Offline
  onlineSynced: string;
  offlineSaved: string;
  syncing: string;
  syncNow: string;
  // Common
  cancel: string;
  save: string;
  delete: string;
  confirm: string;
  close: string;
  adminTitle: string;
}

export const translations: Record<Language, Translations> = {
  en: {
    appName: 'Countup',
    tagline: 'Your Smart Sales Book',
    tabSell: 'Sell',
    tabStock: 'Stock',
    tabCredit: 'Credit',
    tabReports: 'Reports',
    quickSale: 'Quick Sale',
    searchItem: 'Search item...',
    pickItems: 'Tap item to add to sale',
    qty: 'Qty',
    total: 'Total',
    paidNow: 'Paid Now',
    paidCash: 'Cash in Hand',
    paidMomo: 'Mobile Money',
    onCredit: 'On Credit',
    selectCustomer: 'Select customer',
    newCustomer: '+ New Customer',
    customerName: 'Customer Name',
    customerPhone: 'Phone (e.g. 0977...)',
    completeSale: 'Save Sale',
    saleRecorded: 'Sale Saved!',
    saleRecordedSubtitle: 'Stock updated and sale recorded.',
    nextCustomer: 'Next Customer',
    cartEmpty: 'Sale is empty',
    cartEmptyHint: 'Tap any product from the list above to start selling',
    clearCart: 'Clear',
    recentItems: 'Frequently Sold',
    allItems: 'All Items',
    pricePerUnit: 'Each',
    stockLeft: 'in stock',
    outOfStock: 'Out of stock',
    stockTitle: 'Shop Stock',
    addItem: '+ Add New Item',
    editItem: 'Edit Item',
    deleteItem: 'Delete Item',
    itemName: 'Item Name',
    buyingPrice: 'Buying Price (K)',
    sellingPrice: 'Selling Price (K)',
    inStock: 'Current Stock',
    lowStockAlert: 'Low stock alert at',
    lowStockTab: 'Low Stock',
    allStockTab: 'All Stock',
    quickAddStock: 'Quick Restock',
    restocked: 'Stock updated',
    lowStockWarning: 'Items running low on stock!',
    saveItem: 'Save Item',
    noItemsYet: 'No items in stock yet',
    noItemsYetHint: 'Add your goods with buying and selling prices',
    creditTitle: 'Credit Book (Mangawa / Amakongole)',
    totalCreditOwed: 'Total Money Owed to You',
    customersWithDebt: 'Customers Owing Money',
    recordPayment: 'Record Payment',
    sendReminder: 'Send WhatsApp Reminder',
    reminderMessage: 'Polite Reminder Message',
    whatsappReminder: 'Open WhatsApp',
    paymentAmount: 'Amount Paid (K)',
    paymentSaved: 'Payment recorded successfully',
    paymentHistory: 'Payments History',
    debtCleared: 'Debt Cleared! Zero balance.',
    noCreditCustomers: 'No credit customers',
    noCreditHint: 'When customers buy on credit, they will appear here',
    customerHistory: 'Customer Statement',
    creditPurchases: 'Credit Purchases',
    reportsTitle: 'Sales Summary & Profit',
    dailyView: 'Today',
    weeklyView: 'This Week',
    monthlyView: 'This Month',
    totalSales: 'Total Sales',
    totalProfit: 'Net Profit',
    cashReceived: 'Cash In Hand',
    momoReceived: 'MoMo in Phone',
    moneyOwed: 'Credit Given Out',
    topSelling: 'Top Selling Goods',
    noSalesPeriod: 'No sales recorded for this period',
    expenses: 'Shop Expenses',
    addExpense: '+ Record Expense',
    expenseCategory: 'Category',
    expenseAmount: 'Amount Spent (K)',
    expenseNote: 'Note (optional)',
    expenseSaved: 'Expense recorded',
    categories: {
      rent: 'Rent / Stall fee',
      transport: 'Transport / Fare',
      restock: 'Restock goods',
      council_fee: 'Council Levy / Market fee',
      helper_wage: 'Helper / Wages',
      other: 'Other expense',
    },
    exportSummary: 'Share / Export Summary',
    copiedToClipboard: 'Copied to clipboard!',
    planTitle: 'Your Subscription Plan',
    trialBadge: '30-Day Free Trial',
    daysRemaining: 'days remaining',
    planExpired: 'Plan Expired',
    planExpiredNotice: 'Your free trial or plan has ended. Upgrade to continue recording sales.',
    gracePeriodNotice: 'Grace period active. Please renew your plan to avoid interruption.',
    warningNotice: 'Your plan will expire soon. Renew early to keep running smoothly.',
    payNow: 'Pay Now with Mobile Money',
    selectPlan: 'Select a Plan',
    mobileMoneyPayment: 'Pay via Mobile Money',
    enterMomoNumber: 'Mobile Money Number',
    momoPromptInfo: 'You will receive a prompt on your phone to enter your Mobile Money PIN.',
    testPaymentSuccess: 'Payment confirmed! Plan extended.',
    existingDataSafe: 'Your records and stock are always safe, viewable, and exportable.',
    loginTitle: 'Welcome to Countup',
    loginSubtitle: 'Fast sales & stock book for your kiosk',
    phoneNumber: 'Phone Number',
    pin: '4-Digit PIN',
    shopName: 'Shop / Kiosk Name',
    logInBtn: 'Log In to Shop',
    registerBtn: 'Create New Shop',
    switchRegister: 'New shop? Start 30-day free trial',
    switchLogin: 'Already have a shop? Log in here',
    logout: 'Log Out',
    onlineSynced: 'Online & Synced',
    offlineSaved: 'Saved to phone (Offline)',
    syncing: 'Syncing with cloud...',
    syncNow: 'Sync Now',
    cancel: 'Cancel',
    save: 'Save',
    delete: 'Delete',
    confirm: 'Confirm',
    close: 'Close',
    adminTitle: 'Platform Owner Admin',
  },

  bem: {
    appName: 'Countup',
    tagline: 'Icitabo Cenu Ca Malonda',
    tabSell: 'Shitisheni',
    tabStock: 'Ifipe (Stock)',
    tabCredit: 'Amakongole',
    tabReports: 'Amalyashi',
    quickSale: 'Ukushitisha Nomba',
    searchItem: 'Fwayeni icipimo...',
    pickItems: 'Tineni icipimo ukushitisha',
    qty: 'Ubwingi',
    total: 'Pamo Yonse',
    paidNow: 'Alipila Nomba',
    paidCash: 'Cash ya mu Minwe',
    paidMomo: 'MoMo ya pa Foni',
    onCredit: 'Pasoko (Kongole)',
    selectCustomer: 'Saleni umushita',
    newCustomer: '+ Umushita Upya',
    customerName: 'Ishina lya Mushita',
    customerPhone: 'Foni (e.g. 0977...)',
    completeSale: 'Bikeni Malonda',
    saleRecorded: 'Malonda Yabikwa!',
    saleRecordedSubtitle: 'Ifipe fyacepako kabili yasungwa bwino.',
    nextCustomer: 'Umushita Wakonkapo',
    cartEmpty: 'Tapali fyakushitisha',
    cartEmptyHint: 'Tineni icipimo pamulu ukutampa ukushitisha',
    clearCart: 'Fuuteni',
    recentItems: 'Ifishitishiwa Sana',
    allItems: 'Fyonse Ifipe',
    pricePerUnit: 'Cila kamo',
    stockLeft: 'ifishelepo',
    outOfStock: 'Fyapwa',
    stockTitle: 'Ifipe fye Shopu',
    addItem: '+ Bikeni Icipimo Cipya',
    editItem: 'Aluleni Icipimo',
    deleteItem: 'Fumyeni Icipimo',
    itemName: 'Ishina lye Cipe',
    buyingPrice: 'Umutengo wa Kushitila (K)',
    sellingPrice: 'Umutengo wa Kushitishisha (K)',
    inStock: 'Ubwingi bwa Fipe',
    lowStockAlert: 'Cejeceko nga fyapwa pa',
    lowStockTab: 'Ifili Pepi Kupwa',
    allStockTab: 'Fyonse',
    quickAddStock: 'Bikileniko Fipe',
    restocked: 'Ifipe fyaongelwako',
    lowStockWarning: 'Ifipe fimo nafilungama ukupwa!',
    saveItem: 'Bikeni Icipimo',
    noItemsYet: 'Tamusangile ifipe',
    noItemsYetHint: 'Bikeni ifipe fyenu ne mitengo',
    creditTitle: 'Icitabo ca Makongole',
    totalCreditOwed: 'Indalama Bashilalipila ku Shopu',
    customersWithDebt: 'Abashita Bakwete Kongole',
    recordPayment: 'Bikeni Ukulipila',
    sendReminder: 'Tumeniko pa WhatsApp',
    reminderMessage: 'Mashiwi ya Kwibukishako',
    whatsappReminder: 'Isuleni WhatsApp',
    paymentAmount: 'Indalama Shalipilwa (K)',
    paymentSaved: 'Ndalama shalembwa bwino',
    paymentHistory: 'Ifyo balipililepo kale',
    debtCleared: 'Kongole yapwa! Basungwa bwino.',
    noCreditCustomers: 'Takuli bakongole',
    noCreditHint: 'Nga bashita pa kongole, bakamoneka pano',
    customerHistory: 'Amalyashi ya Mushita',
    creditPurchases: 'Ifyo Bashitile pa Kongole',
    reportsTitle: 'Amalyashi na Bunonshi',
    dailyView: 'Lelo',
    weeklyView: 'Uno Mulungu',
    monthlyView: 'Uno Mweshi',
    totalSales: 'Indalama Shonse Sha Malonda',
    totalProfit: 'Bunonshi Bwine Bwine',
    cashReceived: 'Indalama Sha mu Minwe',
    momoReceived: 'Indalama Sha pa Foni (MoMo)',
    moneyOwed: 'Indalama Sha Kongole',
    topSelling: 'Ifishitishiwa Sana',
    noSalesPeriod: 'Tapali malonda yalembwa pali ino nshita',
    expenses: 'Indalama Shaonawilwe ku Shopu',
    addExpense: '+ Lembani Indalama Shasendelwe',
    expenseCategory: 'Ico Shaonawilweko',
    expenseAmount: 'Indalama Shaonawilwe (K)',
    expenseNote: 'Ubulondoloshi (nga mulefwaya)',
    expenseSaved: 'Indalama shalembwa',
    categories: {
      rent: 'Lenti / Umutengo we Tenti',
      transport: 'Lole / Basi / Motoka',
      restock: 'Ukushita ifipe fipya',
      council_fee: 'Indalama sha Kansolo / Market fee',
      helper_wage: 'Malipilo ya Mwaice wa mu shopu',
      other: 'Fimbi ifyaonawilwe',
    },
    exportSummary: 'Tumeni Amalyashi',
    copiedToClipboard: 'Kwakopolwa bwino!',
    planTitle: 'Pulani ya Shopu Yenu',
    trialBadge: 'Inshiku 30 Sha Mahala',
    daysRemaining: 'inshiku shasheelepo',
    planExpired: 'Pulani Yapwa',
    planExpiredNotice: 'Inshiku sha mahala shapwa. Lipileni pakuti mukonkanye ukushitisha.',
    gracePeriodNotice: 'Inshiku sha lisense shili pepi kupwa. Lipileni pakuti tapabifiye.',
    warningNotice: 'Pulani yenu ili pepi kupwa. Mwibwelekesha.',
    payNow: 'Lipileni ne Mobile Money',
    selectPlan: 'Saleni Pulani',
    mobileMoneyPayment: 'Lipileni ne Mobile Money',
    enterMomoNumber: 'Nambala ya Foni ya MoMo',
    momoPromptInfo: 'Mukapokelela ubutumikishi pa foni pakwingisha PIN yenu.',
    testPaymentSuccess: 'Ndalama shapokelelwa! Pulani yaongelwako.',
    existingDataSafe: 'Ifipe ne fyalembwa fyenu fyakalilila fyasungwa bwino kabili tamwakafiluuse.',
    loginTitle: 'Mwapoleni ku Countup',
    loginSubtitle: 'Icitabo ca malonda ca bwangu bwangu',
    phoneNumber: 'Nambala ya Foni',
    pin: 'PIN ya Manambala 4',
    shopName: 'Ishina lye Shopu',
    logInBtn: 'Ingileni mu Shopu',
    registerBtn: 'Isuleni Shopu Ipya',
    switchRegister: 'Shopu ipya? Tampeni inshiku 30 sha mahala',
    switchLogin: 'Mwalikwata kale shopu? Ingileni pano',
    logout: 'Fumeni',
    onlineSynced: 'Pa Intaneti kabili Fyabikwa',
    offlineSaved: 'Fyasungwa pa foni (Tapali Neti)',
    syncing: 'Kulembwa kwi kumbi...',
    syncNow: 'Bikeni Nomba',
    cancel: 'Lekeni',
    save: 'Bikeni',
    delete: 'Fumyeni',
    confirm: 'Suminisheni',
    close: 'Isaleni',
    adminTitle: 'Umuwine wa Platform',
  },

  nya: {
    appName: 'Countup',
    tagline: 'Buku Lanu la Malonda',
    tabSell: 'Gulitsani',
    tabStock: 'Katundu (Stock)',
    tabCredit: 'Mangawa',
    tabReports: 'Malipoti',
    quickSale: 'Kugulitsa Pompano',
    searchItem: 'Fufuzani katundu...',
    pickItems: 'Dindani katundu kuti mugulitse',
    qty: 'Kuchuluka',
    total: 'Yonse Pamodzi',
    paidNow: 'Walipira Pompano',
    paidCash: 'Cash m\'Manja',
    paidMomo: 'MoMo pa Foni',
    onCredit: 'Pa Ngawa (Credit)',
    selectCustomer: 'Sankhani kasitomala',
    newCustomer: '+ Kasitomala Watsopano',
    customerName: 'Dzina la Kasitomala',
    customerPhone: 'Foni (e.g. 0977...)',
    completeSale: 'Sungani Malonda',
    saleRecorded: 'Malonda Asungidwa!',
    saleRecordedSubtitle: 'Katundu wachepa ndipo zinalembedwa bwino.',
    nextCustomer: 'Kasitomala Wotsatira',
    cartEmpty: 'Mugololi mulibe chilichonse',
    cartEmptyHint: 'Dindani chinthu pamwamba kuti muyambe kugulitsa',
    clearCart: 'Chotsani',
    recentItems: 'Zogulitsidwa Kawiri-kawiri',
    allItems: 'Katundu Yense',
    pricePerUnit: 'Chilichonse',
    stockLeft: 'zatsala',
    outOfStock: 'Zatha',
    stockTitle: 'Katundu wa Shopu',
    addItem: '+ Onjezani Katundu',
    editItem: 'Konzani Katundu',
    deleteItem: 'Chotsani Katundu',
    itemName: 'Dzina la Katundu',
    buyingPrice: 'Mtengo Wogulira (K)',
    sellingPrice: 'Mtengo Wogulitsira (K)',
    inStock: 'Zomwe Zilipo',
    lowStockAlert: 'Chenjezani zikatsala',
    lowStockTab: 'Zatsala Pang\'ono',
    allStockTab: 'Zonse',
    quickAddStock: 'Onjezerani Katundu',
    restocked: 'Katundu waonjezedwa',
    lowStockWarning: 'Katundu wina watsala pang\'ono kutha!',
    saveItem: 'Sungani Katundu',
    noItemsYet: 'Mulibe katundu pano',
    noItemsYetHint: 'Onjezani zinthu zanu ndi mitengo yake',
    creditTitle: 'Buku la Mangawa',
    totalCreditOwed: 'Ndalama Zomwe Anthu Akukongolani',
    customersWithDebt: 'Makasitomala Okhala ndi Mangawa',
    recordPayment: 'Lembani Zolipira',
    sendReminder: 'Tumizani Uthenga wa WhatsApp',
    reminderMessage: 'Uthenga Wokumbutsa Mwansangala',
    whatsappReminder: 'Tsegulani WhatsApp',
    paymentAmount: 'Ndalama Zolilipidwa (K)',
    paymentSaved: 'Malipiro alembedwa bwino',
    paymentHistory: 'Mbiri ya Malipiro',
    debtCleared: 'Mangawa atha! Palibe chotsala.',
    noCreditCustomers: 'Palibe makasitomala a mangawa',
    noCreditHint: 'Anthu akatenga katundu pa ngawa, adzaoneka pano',
    customerHistory: 'Mbiri ya Kasitomala',
    creditPurchases: 'Zinthu Zotengedwa pa Ngawa',
    reportsTitle: 'Malipoti a Malonda & Phindu',
    dailyView: 'Lero',
    weeklyView: 'Sabata Ino',
    monthlyView: 'Mwezi Uno',
    totalSales: 'Ndalama Zonse za Malonda',
    totalProfit: 'Phindu Leni-leni',
    cashReceived: 'Ndalama za m\'Manja (Cash)',
    momoReceived: 'Ndalama pa Foni (MoMo)',
    moneyOwed: 'Ndalama za Mangawa',
    topSelling: 'Zogulitsidwa Kwambiri',
    noSalesPeriod: 'Palibe malonda pa nthawi ino',
    expenses: 'Ndalama Zogwiritsidwa Ntchito',
    addExpense: '+ Lembani Zowonongeka',
    expenseCategory: 'Chifukwa',
    expenseAmount: 'Ndalama Zoonongeka (K)',
    expenseNote: 'Mawu ena (ngati alipo)',
    expenseSaved: 'Zowonongeka zalembedwa',
    categories: {
      rent: 'Lendi ya Shopu',
      transport: 'Mayendedwe / Fere',
      restock: 'Kukagula katundu watsopano',
      council_fee: 'Ndalama ya Khansolo / Msika',
      helper_wage: 'Malipiro a wothandiza',
      other: 'Zina ndi zina',
    },
    exportSummary: 'Gawani / Tumizani Lipoti',
    copiedToClipboard: 'Zatengedwa bwino!',
    planTitle: 'Dongosolo Lanu la Shopu',
    trialBadge: 'Masiku 30 a Zaulere',
    daysRemaining: 'masiku otsala',
    planExpired: 'Nthawi Yatha',
    planExpiredNotice: 'Masiku a zaulere atha. Lipirani kuti mupitirize kulemba malonda.',
    gracePeriodNotice: 'Muli m\'masiku achifundo. Lipirani mwamsanga.',
    warningNotice: 'Dongosolo lanu latsala pang\'ono kutha.',
    payNow: 'Lipirani ndi Mobile Money',
    selectPlan: 'Sankhani Dongosolo',
    mobileMoneyPayment: 'Lipirani ndi Mobile Money',
    enterMomoNumber: 'Nambala ya Foni ya MoMo',
    momoPromptInfo: 'Mudzamva uthenga pa foni yanu kuti mulowetse PIN yanu.',
    testPaymentSuccess: 'Malipiro alandiridwa! Nthawi yaonjezedwa.',
    existingDataSafe: 'Katundu wanu ndi mbiri zonse zili bwino ndipo sizidzachotsedwa.',
    loginTitle: 'Takulandirani ku Countup',
    loginSubtitle: 'Buku lachangu la malonda ndi katundu',
    phoneNumber: 'Nambala ya Foni',
    pin: 'PIN ya Manambala 4',
    shopName: 'Dzina la Shopu',
    logInBtn: 'Lowani mu Shopu',
    registerBtn: 'Pangani Shopu Yatsopano',
    switchRegister: 'Shopu yatsopano? Yambani masiku 30 a zaulere',
    switchLogin: 'Muli nayo kale? Lowani pano',
    logout: 'Tulukani',
    onlineSynced: 'Pa Intaneti & Zasungidwa',
    offlineSaved: 'Zasungidwa pa foni (Palibe Net)',
    syncing: 'Zikulembedwa mtambo...',
    syncNow: 'Sungani Tsopano',
    cancel: 'Lekani',
    save: 'Sungani',
    delete: 'Chotsani',
    confirm: 'Tsimikizani',
    close: 'Tsekani',
    adminTitle: 'Mwininyumba wa Pulatifomu',
  },
};
