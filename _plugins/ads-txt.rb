#!/usr/bin/env ruby
#
# `monetization.adsense.id` 가 설정된 경우에만 `/ads.txt` 를 생성한다.
# (애드센스는 ads.txt 가 있어야 광고 수익 손실 없이 게재된다.
#  설정이 비어 있을 때 빈 ads.txt 를 올리면 오히려 광고가 막히므로 파일 자체를 만들지 않는다.)

module Jekyll
  class AdsTxtGenerator < Generator
    safe true
    priority :low

    ADSENSE_EXCHANGE_ID = 'f08c47fec0942fa0'

    def generate(site)
      config = site.config.dig('monetization', 'adsense') || {}
      publisher_id = config['id'].to_s.strip
      extra_lines = Array(site.config.dig('monetization', 'ads_txt_extra_lines'))

      return if publisher_id.empty?

      # ads.txt 에는 'ca-' 접두어를 뺀 pub-XXXXXXXXXXXXXXXX 형식으로 적는다.
      seller_id = publisher_id.sub(/\Aca-/, '')
      lines = ["google.com, #{seller_id}, DIRECT, #{ADSENSE_EXCHANGE_ID}"]
      lines.concat(extra_lines.map(&:to_s))

      page = PageWithoutAFile.new(site, site.source, '', 'ads.txt')
      page.data = { 'layout' => nil, 'sitemap' => false }
      page.content = "#{lines.join("\n")}\n"
      site.pages << page
    end
  end
end
