#!/usr/bin/env python3
# Draws the theme previews of Personal settings > Appearance and accessibility (docs/branding.md,
# "Theme previews"). The theming app shows one picture per theme, from /apps/theming/img/<id>.jpg; the
# upstream pictures show the upstream logo and its blue header. The nourax_branding app shows these
# instead: a NoDrive page in each theme, drawn with plain shapes (no words, so they suit every
# language), with the Nourax logo as it is, only made smaller (never recoloured or redrawn).
#
#   python3 branding/theme-previews/make-previews.py --font OpenDyslexic-Regular.otf
#
# Needs Pillow (12.2.0 was used). --font is the OpenDyslexic font of the theming app
# (apps/theming/fonts/OpenDyslexic-Regular.otf on the server, SIL OFL 1.1): the "Dyslexia font"
# preview is a line of text in that font, as upstream. Writes
# nextcloud-apps/nourax_branding/img/theme-previews/<theme id>.png, 512x320 (two pixels per CSS pixel
# of the 256x160 box). The same input gives the same files. Run it again after a change here, then
# commit the pictures; the server needs nothing else.
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
LOGO = os.path.join(REPO, 'branding', 'nourax-logo.png')
OUT = os.path.join(REPO, 'nextcloud-apps', 'nourax_branding', 'img', 'theme-previews')

# Drawn in a 320x200 grid at K times the size, then made smaller, so edges are smooth.
W, H = 320, 200
OUT_W, OUT_H = 512, 320
K = 8

# Colours from THEME_BIBLE (cobalt #2563EB, light #3B82F6, accent #F97316, light bg #F8FAFC, dark bg
# #0B1220, dark surface #0F172A) and the site's own pages. None is near the upstream blues.
THEMES = {
	'light': dict(frame='#0B1220', bar='#E2E8F0', search='#18223A', nav='#D5D8DD', nav_text='#334155',
		active='#BCC7E0', active_text='#0F172A', content='#FFFFFF', text='#0F172A', muted='#94A3B8',
		line='#E2E8F0', primary='#2563EB', on_primary='#FFFFFF', folder='#2563EB', check='#2563EB',
		avatar='#F97316', border=None),
	'dark': dict(frame='#0B1220', bar='#CBD5E1', search='#18223A', nav='#161B26', nav_text='#CBD5E1',
		active='#2A3550', active_text='#F8FAFC', content='#0F172A', text='#F1F5F9', muted='#64748B',
		line='#1E293B', primary='#2563EB', on_primary='#FFFFFF', folder='#3B82F6', check='#3B82F6',
		avatar='#F97316', border=None),
	'light-highcontrast': dict(frame='#000000', bar='#FFFFFF', search='#000000', nav='#FFFFFF',
		nav_text='#000000', active='#000000', active_text='#FFFFFF', content='#FFFFFF', text='#000000',
		muted='#000000', line='#000000', primary='#1D4ED8', on_primary='#FFFFFF', folder='#1D4ED8',
		check='#000000', avatar='#C2410C', border='#000000', search_border='#FFFFFF'),
	'dark-highcontrast': dict(frame='#000000', bar='#FFFFFF', search='#000000', nav='#000000',
		nav_text='#FFFFFF', active='#FFFFFF', active_text='#000000', content='#000000', text='#FFFFFF',
		muted='#FFFFFF', line='#FFFFFF', primary='#93C5FD', on_primary='#000000', folder='#93C5FD',
		check='#FFFFFF', avatar='#FDBA74', border='#FFFFFF', search_border='#FFFFFF'),
}


def s(v):
	return round(v * K)


def box(x0, y0, x1, y1):
	return [s(x0), s(y0), s(x1) - 1, s(y1) - 1]


def bar(d, x, y, length, colour, height=1.8):
	d.rounded_rectangle(box(x, y - height / 2, x + length, y + height / 2), radius=s(height / 2), fill=colour)


def folder(d, x, y, colour):
	# A folder: a small tab and the body, about 8x6.
	d.rounded_rectangle(box(x, y - 3, x + 3.6, y - 1.6), radius=s(0.6), fill=colour)
	d.rounded_rectangle(box(x, y - 2.2, x + 8, y + 3), radius=s(0.8), fill=colour)


def page_file(d, x, y, colour):
	d.rounded_rectangle(box(x + 1, y - 3, x + 6.5, y + 3), radius=s(0.6), outline=colour, width=s(0.6))


def drive_page(theme, logo):
	"""A NoDrive file list in the given theme, at K times the size."""
	c = THEMES[theme]
	im = Image.new('RGB', (W * K, H * K), c['frame'])
	d = ImageDraw.Draw(im)

	# Top bar: logo, app menu button, app name, search, icons and the person's picture.
	im.paste(logo, (s(5), s(3)), logo)
	for row in range(3):
		for col in range(3):
			cx, cy = 26 + col * 2.4, 6.6 + row * 2.4
			d.ellipse(box(cx - 0.7, cy - 0.7, cx + 0.7, cy + 0.7), fill=c['bar'])
	bar(d, 37, 9, 16, c['bar'], 2.2)
	d.rounded_rectangle(box(112, 4, 208, 14), radius=s(3), fill=c['search'],
		outline=c.get('search_border'), width=s(0.5) if c.get('search_border') else 0)
	d.ellipse(box(117.4, 7.4, 120.6, 10.6), outline=c['bar'], width=s(0.6))
	d.line([s(120.2), s(10.2), s(121.6), s(11.6)], fill=c['bar'], width=s(0.6))
	bar(d, 125, 9, 42, c['bar'], 1.6)
	for x in (258, 270, 282):
		d.ellipse(box(x - 2.3, 6.7, x + 2.3, 11.3), outline=c['bar'], width=s(0.6))
	d.ellipse(box(294.5, 3.5, 305.5, 14.5), fill=c['avatar'])

	# The panel: navigation on the left, the file list on the right.
	d.rounded_rectangle(box(3, 20, 317, 197), radius=s(5), fill=c['nav'],
		outline=c['border'], width=s(0.6) if c['border'] else 0)
	d.rounded_rectangle(box(78, 20, 317, 197), radius=s(5), fill=c['content'],
		outline=c['border'], width=s(0.6) if c['border'] else 0)

	# Navigation: a filter field, the places (the first one open), and two entries at the bottom.
	d.rounded_rectangle(box(7, 24, 66, 31), radius=s(2), fill=c['content'], outline=c['nav_text'], width=s(0.4))
	bar(d, 10, 27.5, 18, c['muted'], 1.5)
	d.ellipse(box(69.6, 26, 72.6, 29), outline=c['nav_text'], width=s(0.5))
	for i, length in enumerate((22, 30, 18, 26, 20, 24, 16)):
		y = 37 + i * 9
		colour = c['nav_text']
		if i == 0:
			d.rounded_rectangle(box(6, y - 3.4, 74, y + 3.4), radius=s(2), fill=c['active'])
			colour = c['active_text']
		d.rounded_rectangle(box(10, y - 1.7, 13.4, y + 1.7), radius=s(0.5), outline=colour, width=s(0.5))
		bar(d, 17, y, length, colour, 1.7)
	for y, length in ((180, 20), (189, 26)):
		d.ellipse(box(10, y - 1.7, 13.4, y + 1.7), outline=c['nav_text'], width=s(0.5))
		bar(d, 17, y, length, c['nav_text'], 1.7)

	# Toolbar: the "New" button, the folder name and the filters.
	d.rounded_rectangle(box(85, 24, 104, 32.5), radius=s(2.5), fill=c['primary'])
	d.line([s(88), s(28.25), s(91), s(28.25)], fill=c['on_primary'], width=s(0.6))
	d.line([s(89.5), s(26.75), s(89.5), s(29.75)], fill=c['on_primary'], width=s(0.6))
	bar(d, 93, 28.25, 8, c['on_primary'], 1.6)
	bar(d, 109, 28.25, 17, c['text'], 1.7)
	for x in (232, 252, 272, 292):
		d.rounded_rectangle(box(x, 26.6, x + 3.2, 29.8), radius=s(0.5), outline=c['text'], width=s(0.5))
		bar(d, x + 5, 28.2, 9, c['text'], 1.5)

	# Recent files, as three cards.
	for x, a, b in ((86, 20, 34), (154, 24, 30), (222, 18, 36)):
		folder(d, x, 46, c['folder'])
		bar(d, x + 11, 44.2, a, c['text'], 1.6)
		bar(d, x + 11, 48.6, b, c['muted'], 1.4)

	# The file list: a header, eight rows (five folders, three files) and the total.
	d.rounded_rectangle(box(85, 57.8, 89.4, 62.2), radius=s(0.6), outline=c['check'], width=s(0.5))
	bar(d, 100, 60, 12, c['muted'], 1.5)
	bar(d, 268, 60, 9, c['muted'], 1.5)
	bar(d, 286, 60, 22, c['muted'], 1.5)
	d.line([s(80), s(64.5), s(316), s(64.5)], fill=c['line'], width=s(0.4))
	for i, length in enumerate((34, 22, 18, 22, 28, 40, 46, 30)):
		y = 70 + i * 10
		d.rounded_rectangle(box(85, y - 2.2, 89.4, y + 2.2), radius=s(0.6), outline=c['check'], width=s(0.5))
		if i < 5:
			folder(d, 92, y, c['folder'])
		else:
			page_file(d, 92, y, c['muted'])
		bar(d, 104, y, length, c['text'], 1.7)
		if i in (0, 5):
			bar(d, 228, y, 12, c['primary'], 1.5)
		d.ellipse(box(250.4, y - 0.5, 251.4, y + 0.5), fill=c['text'])
		d.ellipse(box(252.4, y - 0.5, 253.4, y + 0.5), fill=c['text'])
		d.ellipse(box(254.4, y - 0.5, 255.4, y + 0.5), fill=c['text'])
		bar(d, 266, y, 11, c['muted'], 1.5)
		bar(d, 286, y, 22, c['text'], 1.5)
		d.line([s(80), s(y + 5), s(316), s(y + 5)], fill=c['line'], width=s(0.3))
	bar(d, 104, 154, 30, c['muted'], 1.5)
	bar(d, 268, 154, 12, c['muted'], 1.5)
	return im


def system_default(light, dark):
	"""Light on the upper left, dark on the lower right, with a light-and-dark sign in the middle."""
	mask = Image.new('L', light.size, 0)
	ImageDraw.Draw(mask).polygon([(s(96), s(H)), (s(288), 0), (s(W), 0), (s(W), s(H))], fill=255)
	im = Image.composite(dark, light, mask)
	d = ImageDraw.Draw(im)
	cx, cy = W / 2, H / 2 + 8
	d.ellipse(box(cx - 26, cy - 26, cx + 26, cy + 26), fill='#F8FAFC', outline='#0F172A', width=s(2.4))
	d.pieslice(box(cx - 19, cy - 19, cx + 19, cy + 19), start=-90, end=90, fill='#0F172A')
	return im


def reduced_motion():
	"""A ball that has stopped: its motion lines fade out, and it shows a pause sign."""
	im = Image.new('RGB', (W * K, H * K), '#FFFFFF')
	d = ImageDraw.Draw(im)
	for y, x0, colour in ((80, 92, '#E2E8F0'), (100, 70, '#CBD5E1'), (120, 92, '#E2E8F0')):
		d.rounded_rectangle(box(x0, y - 4, 150, y + 4), radius=s(4), fill=colour)
	d.ellipse(box(152, 60, 232, 140), fill='#0F172A')
	d.rounded_rectangle(box(181, 82, 188, 118), radius=s(1.5), fill='#FFFFFF')
	d.rounded_rectangle(box(196, 82, 203, 118), radius=s(1.5), fill='#FFFFFF')
	return im


def dyslexia(font_path):
	"""A line of text in the OpenDyslexic font."""
	im = Image.new('RGB', (W * K, H * K), '#FFFFFF')
	d = ImageDraw.Draw(im)
	lines = ['The quick brown', 'fox jumped', 'over the lazy', 'brown dog.']
	font = ImageFont.truetype(font_path, s(27))
	step = s(38)
	top = (s(H) - step * len(lines)) // 2 + s(2)
	for i, text in enumerate(lines):
		width = d.textlength(text, font=font)
		d.text(((s(W) - width) / 2, top + i * step), text, font=font, fill='#0F172A')
	return im


def save(im, name):
	small = im.resize((OUT_W, OUT_H), Image.Resampling.LANCZOS)
	path = os.path.join(OUT, name + '.png')
	small.save(path, optimize=True)
	print('wrote', os.path.relpath(path, REPO), os.path.getsize(path), 'bytes')


def main():
	ap = argparse.ArgumentParser(description='Draw the theme previews of the Appearance settings.')
	ap.add_argument('--font', required=True, help='OpenDyslexic-Regular.otf of the theming app')
	args = ap.parse_args()
	if not os.path.isfile(args.font):
		sys.exit('no font file at ' + args.font)
	os.makedirs(OUT, exist_ok=True)
	logo = Image.open(LOGO).convert('RGBA').resize((s(12), s(12)), Image.Resampling.LANCZOS)
	pages = {theme: drive_page(theme, logo) for theme in THEMES}
	for theme, im in pages.items():
		save(im, theme)
	save(system_default(pages['light'], pages['dark']), 'default')
	save(reduced_motion(), 'reduced-motion')
	save(dyslexia(args.font), 'opendyslexic')


if __name__ == '__main__':
	main()
