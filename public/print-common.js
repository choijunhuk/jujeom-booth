/* Shared renderers and table URLs for staff print pages. */
(function () {
  'use strict';
  var h = window.SC.h, won = window.SC.won;

  function absoluteUrl(url) { return new URL(url, location.origin).href; }
  function tableLinks(data) {
    return data.tables.slice().sort(function (a, b) { return a.number - b.number; }).map(function (table) {
      return { number: table.number, url: absoluteUrl(table.url) };
    });
  }
  function originWarning(data) {
    return data.origin ? '' : '서버에 PUBLIC_ORIGIN이 설정되어 있지 않아 지금 열린 주소(' + location.origin + ')로 QR을 만들었어요. 실제 행사 주소에서 이 페이지를 열어 인쇄해야 손님 휴대폰에서 열려요.';
  }

  // forTable: the table board stays on the table all day while prices are tuned live, so it prints no prices at all
  // (not even a bundle's "(따로 사면 N원)"); the guest app shows the current ones.
  function menuSection(menu, forTable) {
    var items = menu.items.filter(function (item) { return !item.hidden && (forTable || !item.soldOut); });
    var groups = menu.categories.map(function (cat) {
      var group = items.filter(function (item) { return item.cat === cat; });
      if (!group.length) return null;
      return h('div', { class: 'fl-menu-group' },
        h('h3', { class: 'fl-category' }, cat),
        group.map(function (item) {
          var desc = forTable ? (item.desc || '').replace(/\s*\(따로 사면 [\d,]+원\)\s*$/, '') : item.components && item.desc;
          return h('div', { class: item.soldOut ? 'fl-item mb-sold' : 'fl-item' },
            h('div', { class: 'fl-item-line' },
              item.soldOut ? h('span', null, h('s', null, item.name), h('strong', { class: 'mb-sold-label' }, '품절')) : h('span', null, item.name),
              forTable ? null : h('span', { class: 'fl-price fl-num' }, won(item.price))),
            desc ? h('p', { class: 'fl-desc' }, desc) : null);
        }));
    });
    return h('section', { class: 'fl-section' }, h('h2', null, '메뉴'),
      items.length ? h('div', { class: 'fl-menu' }, groups) : h('p', null, '판매 중인 메뉴가 없어요.'));
  }

  function memberOn(state) {
    var rule = state.memberDiscount;
    return !!(state.memberEnabled && rule.enabled && ((rule.mode === 'percent' && rule.pct > 0) || (rule.mode === 'fixed' && rule.amount > 0)));
  }

  // Paper stays on the tables all day while thresholds, prizes and discounts are tuned live:
  // print only which benefits exist (as of printing), never numbers; the guest app always shows the current ones.
  function prizeSection(state, data) {
    var lines = [];
    if (data.rewards.some(function (reward) { return reward.active && reward.remaining > 0; })) lines.push('기다리는 동안 미니게임 · 기준 점수 넘기면 할인 쿠폰');
    if (data.hourly.enabled) lines.push('매 정시 1등 테이블 추가 혜택');
    if (memberOn(state)) lines.push('COMS 회원 할인 (장바구니에서 로그인)');
    if (!lines.length) return null;
    lines.push('자세한 혜택은 QR 찍고 확인하세요');
    return h('section', { class: 'fl-section' },
      h('h2', null, '게임 & 혜택'), h('ul', { class: 'fl-prizes' }, lines.map(function (text) { return h('li', null, text); })));
  }

  window.PrintCommon = {
    absoluteUrl: absoluteUrl, tableLinks: tableLinks, originWarning: originWarning,
    menuSection: menuSection, prizeSection: prizeSection
  };
})();
