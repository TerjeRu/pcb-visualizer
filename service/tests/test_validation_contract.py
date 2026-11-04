import copy
import json
import math

import pytest

from pcbv.events import EventError, validate_event
from pcbv.schema import DEFAULT_PROJECT_FILE

import helpers as h


@pytest.mark.parametrize('field', ['x', 'y', 'lx', 'ly', 'w', 'h', 'width', 'height', 'pitch', 'rotation'])
@pytest.mark.parametrize('value', [True, math.nan, math.inf, -math.inf, 1_000_001, -1_000_001, 10 ** 1000])
def test_geometry_rejects_invalid_numbers(field, value):
    with pytest.raises(EventError):
        validate_event({'type': 'marker/updated', 'id': 'marker', 'patch': {field: value}})


@pytest.mark.parametrize('field', ['x', 'y', 'lx', 'ly', 'rotation'])
@pytest.mark.parametrize('value', [-1_000_000, 0, 1_000_000])
def test_coordinates_accept_documented_boundaries(field, value):
    validate_event({'type': 'marker/updated', 'id': 'marker', 'patch': {field: value}})


@pytest.mark.parametrize('field', ['w', 'h', 'width', 'height', 'pitch'])
@pytest.mark.parametrize('value', [0, -1])
def test_lengths_are_positive(field, value):
    with pytest.raises(EventError):
        validate_event({'type': 'marker/updated', 'id': 'marker', 'patch': {field: value}})


@pytest.mark.parametrize('colour', ['', 'red', '#123', '#123456\n', '#123456" onload="bad'])
def test_marker_colours_are_strict(colour):
    with pytest.raises(EventError):
        validate_event({'type': 'marker/updated', 'id': 'marker', 'patch': {'color': colour}})


def test_empty_pin_colour_is_the_approved_unset_value():
    validate_event(h.pin('sch_a', 1, {'color': ''}))
    with pytest.raises(EventError):
        validate_event(h.pin('sch_a', 1, {'color': 'red'}))


@pytest.mark.parametrize('change', ['colour', 'reference', 'capture', 'geometry', 'original'])
def test_invalid_outside_edit_is_preserved_and_not_journaled(seeded, change):
    project = copy.deepcopy(seeded.project)
    if change == 'colour':
        project['markers'][0]['color'] = 'red'
    elif change == 'reference':
        project['markers'][0]['assetId'] = 'missing'
    elif change == 'capture':
        project['captures'] = [{'id': 'bad', 'path': 'captures/a/../../secret'}]
    elif change == 'geometry':
        project['markers'][0]['x'] = math.inf
    else:
        project['assets'][0]['original'] = '../secret'
    path = seeded.directory / DEFAULT_PROJECT_FILE
    raw = json.dumps(project).encode()
    path.write_bytes(raw)
    before = seeded.seq
    seeded.apply({'type': 'project/metaUpdated', 'patch': {'notes': 'valid operation'}})
    assert seeded.seq == before + 1
    assert seeded.project['markers'][0] != project['markers'][0] or change in ('capture', 'original')
    saved = seeded.warning_details['external_edit_preserved']['path']
    assert (seeded.directory / saved).read_bytes() == raw
    assert 'external_edit_preserved' in seeded.warnings


def test_svg_escapes_marker_fields(tmp_path):
    import xml.etree.ElementTree as ET
    from PIL import Image
    from pcbv.export import annotated_svg
    photo = tmp_path / 'photo.png'
    Image.new('RGB', (10, 10)).save(photo)
    colour = '#ffffff" onload="bad'
    svg = annotated_svg(photo, [{'kind': 'point', 'x': 1, 'y': 2, 'color': colour, 'label': '<script>bad</script>'}])
    root = ET.fromstring(svg)
    for node in root.iter():
        assert 'onload' not in node.attrib
        assert not node.tag.endswith('script')
    assert next(n for n in root.iter() if n.tag.endswith('circle')).attrib['stroke'] == colour


def test_interleaved_readings_append_instead_of_replacing(seeded):
    from pcbv.edits import reading_event
    first, _, _ = reading_event(seeded.project, 'Header', 1, '1V', None)
    second, _, _ = reading_event(seeded.project, 'Header', 1, '2V', None)
    assert first['type'] == 'pin/readingAdded'
    seeded.apply(first)
    stored = seeded.apply(second)
    readings = seeded.project['schematics'][0]['pins'][0]['readings']
    assert [r['text'] for r in readings] == ['1 V', '2 V']
    assert stored['seq'] == seeded.seq


@pytest.mark.parametrize('field', ['w', 'h', 'width', 'height', 'pitch'])
@pytest.mark.parametrize('value', [0.01, 1_000_000])
def test_lengths_accept_positive_boundaries(field, value):
    validate_event({'type': 'marker/updated', 'id': 'marker', 'patch': {field: value}})


@pytest.mark.parametrize('field', ['rows', 'cols'])
@pytest.mark.parametrize('value', [True, 0, -1, 65, math.nan, math.inf, 1.5])
def test_grid_dimensions_are_bounded_integers(field, value):
    with pytest.raises(EventError):
        validate_event({'type': 'schematic/updated', 'id': 'schematic', 'patch': {field: value}})


def test_reading_input_has_a_size_limit():
    with pytest.raises(EventError):
        validate_event({'type': 'pin/readingAdded', 'schematicId': 's', 'index': 1, 'reading': {'text': 'x' * 4001}})


def test_export_report_uses_data_folder_playbooks(tmp_path, monkeypatch):
    from pcbv import export
    board = tmp_path / 'boards/board'
    board.mkdir(parents=True)
    selected = []
    def load(directory):
        selected.append(directory)
        return ([{'id': 'custom', 'title': 'Local bench plan', 'steps': [{'id': 'step'}]}], [])
    monkeypatch.setattr(export, 'load_all', load)
    report = export.report_markdown(board, {'playbooks': {'custom': {'steps': {'step': {'done': True}}}}}, [], None)
    assert 'Local bench plan: 1 of 1 steps done' in report
    assert selected == [tmp_path / 'playbooks']


@pytest.mark.parametrize('reference', [[], {}, None, 7, True])
def test_invalid_component_reference_preserves_edit_and_allows_following_requests(seeded, reference):
    project = copy.deepcopy(seeded.project)
    project['components'] = [{'id': 'component', 'assetId': reference}]
    raw = json.dumps(project).encode()
    (seeded.directory / DEFAULT_PROJECT_FILE).write_bytes(raw)
    before = seeded.seq
    for notes in ('first valid request', 'second valid request'):
        seeded.apply({'type': 'project/metaUpdated', 'patch': {'notes': notes}})
        assert seeded.project['meta']['notes'] == notes
    assert seeded.seq == before + 2
    saved = seeded.warning_details['external_edit_preserved']['path']
    assert (seeded.directory / saved).read_bytes() == raw
    assert 'external_edit_preserved' in seeded.warnings
