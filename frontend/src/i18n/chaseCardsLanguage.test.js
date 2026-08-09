import en from './en'

test('English visible copy uses Chase Cards instead of legacy wishlist wording', () => {
    expect(en.settings.users.deleteConfirm).toContain('Chase Cards')
    expect(en.settings.syncPricesOnlyDesc).toContain('Chase Cards')
    expect(en.compare.noTrades).toContain('Chase Cards')
    expect(en.settings.users.deleteConfirm).not.toContain('wishlist')
    expect(en.settings.syncPricesOnlyDesc).not.toContain('wishlist')
    expect(en.compare.noTrades).not.toContain('wishlist')
})
