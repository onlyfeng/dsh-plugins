/** Optional Chinese language pack for the hard-coded discussion links in the rc.5 Forge panel. */
window.__ModuleLoader__.load({
  id: '@onlyfeng/dsh-forge-gitlab',
  factory() {
    return {
      inject: ['locale'],
      apply(ctx) {
        // Older supported hosts may have dictionaries but no external-language catalog.
        if (typeof ctx.locale?.addLanguage !== 'function' || typeof ctx.locale.register !== 'function') return;
        const id = 'zh-x-forge';
        const label = '在代码托管平台查看';
        ctx.effect(() => ctx.locale.register('forgePanel', id, {
          'thread.openOnHost': label,
          'thread.openAll': label,
        }), 'forge-gitlab: Chinese discussion link labels');
        ctx.effect(() => ctx.locale.addLanguage({ id, label: '中文（代码托管平台）', fallback: 'zh' }),
          'forge-gitlab: optional Chinese language');
      },
    };
  },
});
